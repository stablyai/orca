// Pure parts of the egress release probe (egress-probe.ts): the runner it starts in a workspace
// terminal, the requests that runner sends, and what each answer must look like.
import { createHash } from 'node:crypto'
import { EGRESS_DENIED_BODY } from '../src/network-policy'

/**
 * One request from inside the workspace. A header value `$NAME` is read from the VM's env (orcad's
 * environment, as agents get it), so placeholders never cross the terminal.
 */
export type ProbeRequest = { name: string; url: string; method?: 'GET' | 'POST'; headers?: Record<string, string> }

/** What the answer must be. */
export type Expectation =
  /** The echo host answered as the provider: these headers (by sha256) arrived, and nothing from Vercel's hop. */
  | { kind: 'swapped'; headers: Record<string, string> }
  /** The firewall's own 403 (a credential host fails closed). */
  | { kind: 'denied' }
  /** The request reached the provider itself: not the firewall's 403, not an edge block page. */
  | { kind: 'upstream' }

export type ProbeCase = ProbeRequest & { expect: Expectation }

/** What the runner reports per request: never a header value, only sha256 prefixes of the echoed ones. */
export type Summary = {
  status: number
  /** Body is the firewall's deny body. */
  denied: boolean
  /** An HTML 403 from Cloudflare: the provider's edge refused the proxy. */
  edgeBlocked: boolean
  /** The echo host's answer: sha256 prefix of each echoed header, and Vercel hop headers seen. */
  echoed?: Record<string, string>
  leaked?: string[]
}

export const sha8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8)

/**
 * Runs in the workspace (node, from a terminal): fetches each request and prints one short line per
 * fact, `PRB <case> <key>=<value>`, ending with `PRB-END`. Short lines survive the terminal intact.
 * The echo host (postman-echo.com) answers JSON with the request's headers under `headers`.
 */
export const VM_RUNNER = `
const { createHash } = require('node:crypto')
const cases = JSON.parse(Buffer.from(process.argv[1], 'base64').toString())
const sha8 = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 8)
const out = (i, k, v) => console.log('PRB ' + i + ' ' + k + '=' + v)
;(async () => {
  for (const [i, c] of cases.entries()) {
    const headers = {}
    for (const [k, v] of Object.entries(c.headers || {})) headers[k] = v.startsWith('$') ? process.env[v.slice(1)] || '' : v
    try {
      const r = await fetch(c.url, { method: c.method || 'GET', headers, body: c.method === 'POST' ? '{}' : undefined, redirect: 'manual', signal: AbortSignal.timeout(25000) })
      const body = await r.text()
      out(i, 's', r.status)
      out(i, 'd', body.trim() === ${JSON.stringify(EGRESS_DENIED_BODY)} ? 1 : 0)
      out(i, 'cf', r.status === 403 && /text\\/html/.test(r.headers.get('content-type') || '') && /cloudflare/i.test(r.headers.get('server') || '') ? 1 : 0)
      let echo = null
      try { echo = JSON.parse(body).headers } catch {}
      if (echo && typeof echo === 'object') {
        for (const [k, v] of Object.entries(echo)) {
          if (/^vercel-forwarded-|oidc/i.test(k)) out(i, 'leak', k)
          else if (k in (c.headers || {})) out(i, 'h.' + k, sha8(v))
        }
      }
    } catch (e) {
      out(i, 's', 0)
    }
  }
  console.log('PRB-END')
})()
`

export function parseRunnerOutput(text: string, count: number): Summary[] {
  const summaries: Summary[] = Array.from({ length: count }, () => ({ status: 0, denied: false, edgeBlocked: false }))
  for (const match of text.matchAll(/PRB (\d+) ([a-z.-]+)=(\S+)/g)) {
    const summary = summaries[Number(match[1])]
    const [key, value] = [match[2]!, match[3]!]
    if (!summary) {
      continue
    }
    if (key === 's') summary.status = Number(value)
    else if (key === 'd') summary.denied = value === '1'
    else if (key === 'cf') summary.edgeBlocked = value === '1'
    else if (key === 'leak') summary.leaked = [...(summary.leaked ?? []), value]
    else if (key.startsWith('h.')) summary.echoed = { ...summary.echoed, [key.slice(2)]: value }
  }
  return summaries
}

/** Problems with one answer; empty when it is what the case expects. Never quotes a header value. */
export function judge(probe: ProbeCase, answer: Summary): string[] {
  const { expect } = probe
  const denied = answer.status === 403 && answer.denied
  if (expect.kind === 'denied') {
    return denied ? [] : [`${probe.name}: expected the firewall's 403 ${EGRESS_DENIED_BODY}, got ${answer.status}`]
  }
  if (expect.kind === 'upstream') {
    if (denied) return [`${probe.name}: refused by the firewall`]
    if (answer.edgeBlocked) return [`${probe.name}: the provider's edge refused the egress proxy (Cloudflare 403 page)`]
    return answer.status === 0 ? [`${probe.name}: no answer`] : []
  }
  if (answer.status !== 200 || !answer.echoed) {
    return [`${probe.name}: expected the echo host's answer, got ${answer.status}${denied ? ' (denied)' : ''}`]
  }
  const problems = (answer.leaked ?? []).map((name) => `${probe.name}: the provider saw ${name}`)
  for (const [name, value] of Object.entries(expect.headers)) {
    if (answer.echoed[name] !== sha8(value)) {
      problems.push(`${probe.name}: header ${name} ${answer.echoed[name] ? 'arrived with another value' : 'did not arrive'}`)
    }
  }
  return problems
}

/** The terminal line that runs the cases: the runner and its input both base64, one shell word each. */
export function runnerCommand(cases: readonly ProbeRequest[]): string {
  const runner = Buffer.from(VM_RUNNER).toString('base64')
  const input = Buffer.from(JSON.stringify(cases.map(({ name: _name, ...request }) => request))).toString('base64')
  return `node -e "$(echo ${runner} | base64 -d)" ${input}`
}
