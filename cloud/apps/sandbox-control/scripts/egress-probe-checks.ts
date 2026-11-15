// Pure parts of the egress release probe (egress-probe.ts): the echo server it runs, the requests
// it sends from the probe VM, and what each answer must look like.
import { EGRESS_DENIED_BODY } from '../src/network-policy'

/**
 * Runs in the echo sandbox: answers every request with its method, path and headers as JSON. Vercel's
 * per-sandbox OIDC token (on forwarded requests) is reported as present, never echoed.
 */
export const ECHO_SERVER = `
require('node:http').createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) headers[name] = /oidc/i.test(name) ? '[present]' : value
    const body = JSON.stringify({ probeEcho: true, method: req.method, url: req.url, headers })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
}).listen(Number(process.argv[1] || 8080))
`

/** One request from the probe VM. `headers` values may name env vars (`$NAME`), expanded in the VM. */
export type ProbeRequest = { name: string; url: string; method?: 'GET' | 'POST'; headers?: Record<string, string> }

/** What the answer must be: echoed through the forward rule, refused by the firewall, or passed upstream. */
export type Expectation =
  /** Vercel's forward rule sent it on unchanged (the probe's echo stands in for the egress proxy). */
  | { kind: 'forwarded'; host: string; headers: Record<string, string> }
  /** The egress proxy swapped the placeholder and sent it to the host (the echo is that host). */
  | { kind: 'swapped'; headers: Record<string, string> }
  | { kind: 'denied' }
  | { kind: 'upstream'; notDenied: true }

export type ProbeCase = ProbeRequest & { expect: Expectation }

export type Answer = { status: number; body: string }

type Echo = { probeEcho: true; method: string; url: string; headers: Record<string, string | string[] | undefined> }

function parseEcho(body: string): Echo | null {
  try {
    const value = JSON.parse(body) as Partial<Echo>
    return value.probeEcho === true && typeof value.headers === 'object' ? (value as Echo) : null
  } catch {
    return null
  }
}

/** Problems with one answer; empty means it is what the case expects. Never quotes header values. */
export function judge(probe: ProbeCase, answer: Answer): string[] {
  const { expect } = probe
  const denied = answer.status === 403 && answer.body.trim() === EGRESS_DENIED_BODY
  if (expect.kind === 'denied') {
    return denied ? [] : [`${probe.name}: expected the firewall's 403 ${EGRESS_DENIED_BODY}, got ${answer.status}`]
  }
  if (expect.kind === 'upstream') {
    return denied || answer.status === 0 ? [`${probe.name}: expected the request to reach the host, got ${answer.status}${denied ? ' (denied)' : ''}`] : []
  }
  const echo = parseEcho(answer.body)
  if (!echo) {
    return [`${probe.name}: expected the forward target's echo, got ${answer.status}${denied ? ' (denied)' : ''}`]
  }
  const problems: string[] = []
  if (expect.kind === 'swapped') {
    // Nothing from Vercel's forward hop (routing headers, the sandbox's OIDC token) reaches the provider.
    const leaked = Object.keys(echo.headers).filter((name) => name.startsWith('vercel-forwarded-') || /oidc/i.test(name))
    if (leaked.length > 0) {
      problems.push(`${probe.name}: the provider saw ${leaked.join(', ')}`)
    }
  } else if (echo.headers['vercel-forwarded-host'] !== expect.host) {
    problems.push(`${probe.name}: forwarded for ${JSON.stringify(echo.headers['vercel-forwarded-host'])}, expected ${expect.host}`)
  }
  if (expect.kind === 'forwarded' && echo.headers['vercel-sandbox-oidc-token'] !== '[present]') {
    problems.push(`${probe.name}: forwarded without the sandbox OIDC token`)
  }
  for (const [name, value] of Object.entries(expect.headers)) {
    if (echo.headers[name] !== value) {
      problems.push(`${probe.name}: header ${name} was ${echo.headers[name] === undefined ? 'dropped' : 'changed'} on the way`)
    }
  }
  return problems
}

/**
 * The probe VM's script: one `name<TAB>status<TAB>base64(body)` line per request. Header values
 * starting with `$` are read from the command's env, so placeholders never sit in argv.
 */
export function probeScript(cases: readonly ProbeRequest[]): string {
  const lines = ['set -u', 'out=$(mktemp)']
  for (const probe of cases) {
    const headers = Object.entries(probe.headers ?? {}).map(([name, value]) =>
      value.startsWith('$') ? `-H "${name}: \${${value.slice(1)}}"` : `-H ${shellQuote(`${name}: ${value}`)}`
    )
    lines.push(
      `code=$(curl -s -m 20 -o "$out" -w '%{http_code}' -X ${probe.method ?? 'GET'} ${headers.join(' ')} ${shellQuote(probe.url)} || true)`,
      `printf '%s\\t%s\\t%s\\n' ${shellQuote(probe.name)} "\${code:-0}" "$(head -c 20000 "$out" | base64 -w0)"`
    )
  }
  return lines.join('\n')
}

export function parseProbeOutput(stdout: string): Map<string, Answer> {
  const answers = new Map<string, Answer>()
  for (const line of stdout.split('\n')) {
    const [name, status, body] = line.split('\t')
    if (name && status !== undefined && body !== undefined) {
      answers.set(name, { status: Number(status) || 0, body: Buffer.from(body, 'base64').toString('utf8') })
    }
  }
  return answers
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
