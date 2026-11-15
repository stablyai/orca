// Pure parts of the egress release probe (egress-probe.ts): the runner it starts in a workspace
// terminal, the requests that runner sends, and what each answer must look like.
import { createHash } from 'node:crypto'
import { EGRESS_DENIED_BODY } from '../src/network-policy'

/**
 * One request from inside the workspace. A header value `$NAME` is read from the VM's env (orcad's
 * environment, as agents get it), so placeholders never cross the terminal.
 */
export type ProbeRequest = {
  name: string
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** POST a body of this many bytes (large uploads). */
  uploadBytes?: number
  /** Read the body chunk by chunk (SSE / chunked streams): reports chunks and time to the first one. */
  stream?: boolean
  /** An HTTP/1.1 WebSocket upgrade instead of a fetch: reports 101 on success. */
  websocket?: boolean
  /** Samples for latency (sequential, one keep-alive client, like an agent's calls). Default 1. */
  repeat?: number
  /** Latency class this request measures (report key). */
  latency?: string
}

/** What the answer must be. */
export type Expectation =
  /** The echo host answered as the provider: `headers` arrived with these values (the swap), `keep` arrived as sent. */
  | { kind: 'swapped'; headers: Record<string, string>; keep?: readonly string[] }
  /** The headers arrived exactly as sent: a placeholder on a host it isn't for is never swapped. */
  | { kind: 'unswapped'; headers: readonly string[] }
  /** The firewall's own 403 (a credential host fails closed). */
  | { kind: 'denied' }
  /** The provider itself answered: not the firewall's 403, not an edge block page, no hang. */
  | { kind: 'upstream' }
  /** A 200 that streamed at least this many chunks without hanging. */
  | { kind: 'streamed'; minChunks: number }
  /** The WebSocket upgrade went through (101). */
  | { kind: 'upgraded' }

export type ProbeCase = ProbeRequest & { expect: Expectation }

/** What the runner reports per request: never a header value, only sha256 prefixes. */
export type Summary = {
  status: number
  denied: boolean
  edgeBlocked: boolean
  /** The client gave up waiting for the answer or its body (the undici framing hang). */
  hang: boolean
  /** Total ms per sample. */
  ms: number[]
  chunks?: number
  ttfbMs?: number
  /** sha256 prefix of each header as the echo host received it, and as the VM sent it. */
  echoed?: Record<string, string>
  sent?: Record<string, string>
  leaked?: string[]
}

export const sha8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8)

/**
 * Runs in the workspace (node, from a terminal). Prints one short line per fact, `PRB <case> <key>=<value>`,
 * then `PRB-END`. Short lines survive the terminal intact. Echo hosts answer JSON with the request's
 * headers under `headers` (postman-echo.com, httpbin.org); header names are compared lowercased.
 */
export const VM_RUNNER = `
const { createHash } = require('node:crypto')
const https = require('node:https')
const cases = JSON.parse(Buffer.from(process.argv[1], 'base64').toString())
const sha8 = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 8)
const out = (i, k, v) => console.log('PRB ' + i + ' ' + k + '=' + v)
const DENIED = ${JSON.stringify(EGRESS_DENIED_BODY)}
function upgrade(c, headers) {
  return new Promise((resolve) => {
    const u = new URL(c.url)
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }, timeout: 20000 })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, body: '' }) })
    req.on('response', (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, hang: true, body: '' }) })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}
;(async () => {
  for (const [i, c] of cases.entries()) {
    const headers = {}
    for (const [k, v] of Object.entries(c.headers || {})) {
      headers[k] = v.startsWith('$') ? process.env[v.slice(1)] || '' : v
      out(i, 'sent.' + k.toLowerCase(), sha8(headers[k]))
    }
    for (let n = 0; n < (c.repeat || 1); n++) {
      const t0 = Date.now()
      let r = { status: 0, body: '' }
      if (c.websocket) {
        r = await upgrade(c, headers)
      } else {
        try {
          const body = c.uploadBytes ? Buffer.alloc(c.uploadBytes, 97) : c.method === 'POST' ? '{}' : undefined
          const res = await fetch(c.url, { method: c.method || 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
          let text = ''
          if (c.stream) {
            let chunks = 0
            const reader = res.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (chunks++ === 0) out(i, 'ttfb', Date.now() - t0)
              if (text.length < 4000) text += Buffer.from(value).toString()
            }
            out(i, 'chunks', chunks)
          } else {
            text = await res.text()
          }
          r = { status: res.status, body: text, cf: res.status === 403 && /text\\/html/.test(res.headers.get('content-type') || '') && /cloudflare/i.test(res.headers.get('server') || '') }
        } catch (e) {
          r = { status: 0, body: '', hang: e && (e.name === 'TimeoutError' || e.name === 'AbortError') }
        }
      }
      out(i, 'ms', Date.now() - t0)
      if (n > 0) continue
      out(i, 's', r.status)
      out(i, 'd', r.body.trim() === DENIED ? 1 : 0)
      out(i, 'cf', r.cf ? 1 : 0)
      out(i, 'hang', r.hang ? 1 : 0)
      let echo = null
      try { echo = JSON.parse(r.body).headers } catch {}
      if (echo && typeof echo === 'object') {
        for (const [k, v] of Object.entries(echo)) {
          const name = k.toLowerCase()
          if (/^vercel-forwarded-|oidc/.test(name)) out(i, 'leak', name)
          else if (Object.keys(c.headers || {}).some((h) => h.toLowerCase() === name)) out(i, 'h.' + name, sha8(v))
        }
      }
    }
  }
  console.log('PRB-END')
})()
`

export function parseRunnerOutput(text: string, count: number): Summary[] {
  const summaries: Summary[] = Array.from({ length: count }, () => ({ status: 0, denied: false, edgeBlocked: false, hang: false, ms: [] }))
  for (const match of text.matchAll(/PRB (\d+) ([a-z0-9.-]+)=(\S+)/g)) {
    const summary = summaries[Number(match[1])]
    const [key, value] = [match[2]!, match[3]!]
    if (!summary) continue
    if (key === 's') summary.status = Number(value)
    else if (key === 'd') summary.denied = value === '1'
    else if (key === 'cf') summary.edgeBlocked = value === '1'
    else if (key === 'hang') summary.hang = value === '1'
    else if (key === 'ms') summary.ms.push(Number(value))
    else if (key === 'chunks') summary.chunks = Number(value)
    else if (key === 'ttfb') summary.ttfbMs = Number(value)
    else if (key === 'leak') summary.leaked = [...(summary.leaked ?? []), value]
    else if (key.startsWith('h.')) summary.echoed = { ...summary.echoed, [key.slice(2)]: value }
    else if (key.startsWith('sent.')) summary.sent = { ...summary.sent, [key.slice(5)]: value }
  }
  return summaries
}

/** Problems with one answer; empty when it is what the case expects. Never quotes a header value. */
export function judge(probe: ProbeCase, answer: Summary): string[] {
  const { expect } = probe
  const denied = answer.status === 403 && answer.denied
  if (answer.hang) {
    return [`${probe.name}: the client hung waiting for the answer (undici framing hang?)`]
  }
  switch (expect.kind) {
    case 'denied':
      return denied ? [] : [`${probe.name}: expected the firewall's 403 ${EGRESS_DENIED_BODY}, got ${answer.status}`]
    case 'upstream':
      if (denied) return [`${probe.name}: refused by the firewall`]
      if (answer.edgeBlocked) return [`${probe.name}: the provider's edge refused our egress (Cloudflare 403 page)`]
      return answer.status === 0 ? [`${probe.name}: no answer`] : []
    case 'upgraded':
      return answer.status === 101 ? [] : [`${probe.name}: expected a WebSocket upgrade (101), got ${answer.status}${denied ? ' (denied)' : ''}`]
    case 'streamed':
      return answer.status === 200 && (answer.chunks ?? 0) >= expect.minChunks
        ? []
        : [`${probe.name}: expected a 200 stream of ${expect.minChunks}+ chunks, got ${answer.status} with ${answer.chunks ?? 0}`]
    case 'swapped':
    case 'unswapped': {
      if (answer.status !== 200 || !answer.echoed) {
        return [`${probe.name}: expected the echo host's answer, got ${answer.status}${denied ? ' (denied)' : ''}`]
      }
      const problems = (answer.leaked ?? []).map((name) => `${probe.name}: the provider saw ${name}`)
      const swapped = expect.kind === 'swapped' ? expect.headers : {}
      for (const [name, value] of Object.entries(swapped)) {
        if (answer.echoed[name] !== sha8(value)) {
          problems.push(`${probe.name}: header ${name} ${answer.echoed[name] ? 'arrived with another value' : 'did not arrive'}`)
        }
      }
      const unchanged = expect.kind === 'swapped' ? (expect.keep ?? []) : expect.headers
      for (const name of unchanged) {
        if (!answer.echoed[name] || answer.echoed[name] !== answer.sent?.[name]) {
          problems.push(`${probe.name}: header ${name} ${answer.echoed[name] ? 'was changed on the way' : 'did not arrive'}`)
        }
      }
      return problems
    }
  }
}

/** Median and p90 of each latency class across these answers. */
export function latencyByClass(cases: readonly ProbeCase[], answers: readonly Summary[]): Record<string, { n: number; medianMs: number; p90Ms: number }> {
  const samples: Record<string, number[]> = {}
  cases.forEach((probe, i) => {
    if (probe.latency && answers[i] && !answers[i]!.hang && answers[i]!.status !== 0) {
      ;(samples[probe.latency] ??= []).push(...answers[i]!.ms)
    }
  })
  const pick = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return Object.fromEntries(
    Object.entries(samples).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return [name, { n: sorted.length, medianMs: pick(sorted, 0.5), p90Ms: pick(sorted, 0.9) }]
    })
  )
}

/** The terminal line that runs the cases: the runner and its input both base64, one shell word each. */
export function runnerCommand(cases: readonly ProbeRequest[]): string {
  const runner = Buffer.from(VM_RUNNER).toString('base64')
  const input = Buffer.from(JSON.stringify(cases.map(({ name: _name, ...request }) => request))).toString('base64')
  return `node -e "$(echo ${runner} | base64 -d)" ${input}`
}
