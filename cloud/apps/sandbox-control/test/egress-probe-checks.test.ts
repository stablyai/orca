import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { EGRESS_DENIED_BODY } from '../src/network-policy'
import { judge, latencyByClass, parseRunnerOutput, runnerCommand, sha8, type ProbeCase, type Summary } from '../scripts/egress-probe-checks'

const answer = (summary: Partial<Summary>): Summary => ({ status: 200, denied: false, edgeBlocked: false, hang: false, ms: [10], ...summary })

describe('egress probe judge', () => {
  const swapped: ProbeCase = { name: 'echo', url: 'https://echo/post', expect: { kind: 'swapped', headers: { 'x-api-key': 'stand-in' }, keep: ['authorization'] } }
  const sent = { 'x-api-key': sha8('orca-ph-placeholder'), authorization: sha8('Bearer keep') }

  it('accepts the provider seeing the swapped key and the other header unchanged', () => {
    expect(judge(swapped, answer({ sent, echoed: { 'x-api-key': sha8('stand-in'), authorization: sha8('Bearer keep') } }))).toEqual([])
  })

  it('names a header that changed or never arrived, and anything leaked from the hop, never values', () => {
    const problems = judge(swapped, answer({ sent, echoed: { 'x-api-key': sha8('orca-ph-placeholder') }, leaked: ['vercel-sandbox-oidc-token'] }))
    expect(problems).toEqual([
      'echo: the provider saw vercel-sandbox-oidc-token',
      'echo: header x-api-key arrived with another value',
      'echo: header authorization did not arrive'
    ])
    expect(problems.join(' ')).not.toContain('stand-in')
  })

  it("requires the firewall's own 403 for a fail-closed case", () => {
    const denied: ProbeCase = { name: 'foreign', url: 'https://x', expect: { kind: 'denied' } }
    expect(judge(denied, answer({ status: 403, denied: true }))).toEqual([])
    expect(judge(denied, answer({ status: 403, edgeBlocked: true }))).toHaveLength(1)
    expect(judge(denied, answer({ status: 401 }))).toHaveLength(1)
  })

  it('an upstream case fails on the firewall 403, an edge block page or no answer', () => {
    const upstream: ProbeCase = { name: 'chatgpt', url: 'https://chatgpt.com/x', expect: { kind: 'upstream' } }
    expect(judge(upstream, answer({ status: 401 }))).toEqual([])
    expect(judge(upstream, answer({ status: 403, denied: true }))).toEqual(['chatgpt: refused by the firewall'])
    expect(judge(upstream, answer({ status: 403, edgeBlocked: true }))).toHaveLength(1)
    expect(judge(upstream, answer({ status: 0 }))).toEqual(['chatgpt: no answer'])
  })
})

describe('egress probe: hangs, streams, upgrades, leaks and latency', () => {
  it('a hang fails every kind, even a fail-closed one', () => {
    expect(judge({ name: 'x', url: 'u', expect: { kind: 'denied' } }, answer({ hang: true, status: 0 }))).toEqual(['x: the client hung waiting for the answer (undici framing hang?)'])
  })

  it('a placeholder on another host must arrive exactly as sent', () => {
    const leak: ProbeCase = { name: 'leak', url: 'https://other/anything', expect: { kind: 'unswapped', headers: ['x-api-key'] } }
    const sent = { 'x-api-key': sha8('orca-ph-x') }
    expect(judge(leak, answer({ sent, echoed: sent }))).toEqual([])
    expect(judge(leak, answer({ sent, echoed: { 'x-api-key': sha8('the real key') } }))).toEqual(['leak: header x-api-key was changed on the way'])
  })

  it('streams need chunks and a 200; upgrades need a 101', () => {
    expect(judge({ name: 's', url: 'u', expect: { kind: 'streamed', minChunks: 2 } }, answer({ chunks: 3 }))).toEqual([])
    expect(judge({ name: 's', url: 'u', expect: { kind: 'streamed', minChunks: 2 } }, answer({ chunks: 1 }))).toHaveLength(1)
    expect(judge({ name: 'w', url: 'u', expect: { kind: 'upgraded' } }, answer({ status: 101 }))).toEqual([])
    expect(judge({ name: 'w', url: 'u', expect: { kind: 'upgraded' } }, answer({ status: 403, denied: true }))).toEqual(['w: expected a WebSocket upgrade (101), got 403 (denied)'])
  })

  it('latency per class: median and p90 over every sample, hangs left out', () => {
    const cases: ProbeCase[] = [
      { name: 'a', url: 'u', latency: 'git', expect: { kind: 'upstream' } },
      { name: 'b', url: 'u', latency: 'git', expect: { kind: 'upstream' } },
      { name: 'c', url: 'u', latency: 'git', expect: { kind: 'upstream' } }
    ]
    expect(latencyByClass(cases, [answer({ ms: [10, 30, 20] }), answer({ ms: [40, 50] }), answer({ hang: true, ms: [30000] })])).toEqual({ git: { n: 5, medianMs: 30, p90Ms: 50 } })
  })
})

describe('the in-VM runner', () => {
  it('reports status, the deny body and echoed header digests from env-held values', async () => {
    // A local stand-in for postman-echo.com: echoes request headers under `headers`.
    const server = createServer((req, res) => {
      if (req.url === '/denied') {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(EGRESS_DENIED_BODY)
        return
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: 1\n\n')
        setTimeout(() => res.end('data: 2\n\n'), 50)
        return
      }
      let bytes = 0
      req.on('data', (chunk: Buffer) => (bytes += chunk.length))
      req.on('end', () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytes, headers: { ...req.headers, 'Vercel-Forwarded-Host': 'x' } }))
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const cases = [
      { name: 'echo', url: `${base}/post`, method: 'POST' as const, headers: { 'x-api-key': '$PH', authorization: 'Bearer keep' } },
      { name: 'denied', url: `${base}/denied` },
      { name: 'stream', url: `${base}/stream`, stream: true },
      { name: 'upload', url: `${base}/post`, method: 'POST' as const, uploadBytes: 1 << 20, repeat: 3 }
    ]
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile('bash', ['-c', runnerCommand(cases)], { env: { ...process.env, PH: 'secret-ph' } }, (error, out) => (error ? reject(error) : resolve(out)))
    )
    server.close()
    expect(stdout).toContain('PRB-END')
    expect(stdout).not.toContain('secret-ph')
    const [echo, denied, stream, upload] = parseRunnerOutput(stdout, 4)
    expect(echo).toMatchObject({
      status: 200,
      hang: false,
      sent: { 'x-api-key': sha8('secret-ph'), authorization: sha8('Bearer keep') },
      echoed: { 'x-api-key': sha8('secret-ph'), authorization: sha8('Bearer keep') },
      leaked: ['vercel-forwarded-host']
    })
    expect(denied).toMatchObject({ status: 403, denied: true })
    expect(stream).toMatchObject({ status: 200, hang: false })
    expect(stream!.chunks).toBeGreaterThanOrEqual(2)
    expect(upload).toMatchObject({ status: 200 })
    expect(upload!.ms).toHaveLength(3)
  })
})
