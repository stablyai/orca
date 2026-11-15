import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { EGRESS_DENIED_BODY } from '../src/network-policy'
import { judge, parseRunnerOutput, runnerCommand, sha8, type ProbeCase, type Summary } from '../scripts/egress-probe-checks'

const answer = (summary: Partial<Summary>): Summary => ({ status: 200, denied: false, edgeBlocked: false, ...summary })

describe('egress probe judge', () => {
  const swapped: ProbeCase = { name: 'echo', url: 'https://echo/post', expect: { kind: 'swapped', headers: { 'x-api-key': 'stand-in', authorization: 'Bearer keep' } } }

  it('accepts the provider seeing the swapped key and the other header unchanged', () => {
    expect(judge(swapped, answer({ echoed: { 'x-api-key': sha8('stand-in'), authorization: sha8('Bearer keep') } }))).toEqual([])
  })

  it('names a header that changed or never arrived, and anything leaked from the hop, never values', () => {
    const problems = judge(swapped, answer({ echoed: { 'x-api-key': sha8('orca-ph-placeholder') }, leaked: ['vercel-sandbox-oidc-token'] }))
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

describe('the in-VM runner', () => {
  it('reports status, the deny body and echoed header digests from env-held values', async () => {
    // A local stand-in for postman-echo.com: echoes request headers under `headers`.
    const server = createServer((req, res) => {
      if (req.url === '/denied') {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(EGRESS_DENIED_BODY)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ headers: { ...req.headers, 'vercel-forwarded-host': 'x' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const cases = [
      { name: 'echo', url: `${base}/post`, method: 'POST' as const, headers: { 'x-api-key': '$PH', authorization: 'Bearer keep' } },
      { name: 'denied', url: `${base}/denied` }
    ]
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile('bash', ['-c', runnerCommand(cases)], { env: { ...process.env, PH: 'secret-ph' } }, (error, out) => (error ? reject(error) : resolve(out)))
    )
    server.close()
    expect(stdout).toContain('PRB-END')
    expect(stdout).not.toContain('secret-ph')
    const [echo, denied] = parseRunnerOutput(stdout, 2)
    expect(echo).toEqual({ status: 200, denied: false, edgeBlocked: false, echoed: { 'x-api-key': sha8('secret-ph'), authorization: sha8('Bearer keep') }, leaked: ['vercel-forwarded-host'] })
    expect(denied).toMatchObject({ status: 403, denied: true })
  })
})
