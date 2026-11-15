import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { EGRESS_DENIED_BODY } from '../src/network-policy'
import { judge, parseProbeOutput, probeScript, type ProbeCase } from '../scripts/egress-probe-checks'

const echo = (headers: Record<string, string>) => JSON.stringify({ probeEcho: true, method: 'GET', url: '/x', headers })

describe('egress probe judge', () => {
  const forwarded: ProbeCase = {
    name: 'chatgpt',
    url: 'https://chatgpt.com/x',
    expect: { kind: 'forwarded', host: 'chatgpt.com', headers: { authorization: 'Bearer ph', 'x-api-key': 'keep' } }
  }

  it('accepts a forward for the right host with every listed header unchanged', () => {
    const body = echo({ 'vercel-forwarded-host': 'chatgpt.com', 'vercel-sandbox-oidc-token': '[present]', authorization: 'Bearer ph', 'x-api-key': 'keep' })
    expect(judge(forwarded, { status: 200, body })).toEqual([])
  })

  it('names a changed or dropped header and a wrong host, never the values', () => {
    const body = echo({ 'vercel-forwarded-host': 'api.openai.com', 'vercel-sandbox-oidc-token': '[present]', authorization: 'Bearer real-secret' })
    const problems = judge(forwarded, { status: 200, body })
    expect(problems).toEqual([
      'chatgpt: forwarded for "api.openai.com", expected chatgpt.com',
      'chatgpt: header authorization was changed on the way',
      'chatgpt: header x-api-key was dropped on the way'
    ])
    expect(problems.join(' ')).not.toContain('real-secret')
  })

  it("requires the firewall's own 403 body for a fail-closed case", () => {
    const denied: ProbeCase = { name: 'foreign', url: 'https://chatgpt.com/x', expect: { kind: 'denied' } }
    expect(judge(denied, { status: 403, body: `${EGRESS_DENIED_BODY}\n` })).toEqual([])
    expect(judge(denied, { status: 403, body: '<html>cloudflare</html>' })).toHaveLength(1)
    expect(judge(denied, { status: 200, body: echo({}) })).toHaveLength(1)
  })

  it('treats a denial or no answer as failing an upstream case', () => {
    const upstream: ProbeCase = { name: 'anon git', url: 'https://github.com/x', expect: { kind: 'upstream', notDenied: true } }
    expect(judge(upstream, { status: 200, body: '001e# service=git-upload-pack' })).toEqual([])
    expect(judge(upstream, { status: 403, body: EGRESS_DENIED_BODY })).toHaveLength(1)
    expect(judge(upstream, { status: 0, body: '' })).toHaveLength(1)
  })

  it('a swapped request must carry nothing from the forward hop', () => {
    const swapped: ProbeCase = { name: 'swap', url: 'https://echo/x', expect: { kind: 'swapped', headers: { 'x-api-key': 'stand-in' } } }
    expect(judge(swapped, { status: 200, body: echo({ 'x-api-key': 'stand-in' }) })).toEqual([])
    expect(judge(swapped, { status: 200, body: echo({ 'x-api-key': 'stand-in', 'vercel-sandbox-oidc-token': '[present]' }) })).toEqual([
      'swap: the provider saw vercel-sandbox-oidc-token'
    ])
  })
})

describe('probeScript', () => {
  it('reads $NAME header values from env and reports one line per request', () => {
    const script = probeScript([{ name: "it's one", url: 'http://127.0.0.1:9/never', headers: { authorization: '$PH', 'x-other': 'literal' } }])
    expect(script).toContain('-H "authorization: ${PH}"')
    expect(script).toContain("-H 'x-other: literal'")
    const answers = parseProbeOutput(execFileSync('bash', ['-c', script], { env: { ...process.env, PH: 'Bearer x' }, encoding: 'utf8' }))
    expect(answers.get("it's one")).toEqual({ status: 0, body: '' })
  })
})
