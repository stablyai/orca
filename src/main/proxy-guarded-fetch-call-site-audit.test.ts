import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Startup applies the persisted proxy to `session.defaultSession` only, and
// `installElectronProxyRequestGuard(session.defaultSession)` is what actually holds requests
// until that apply (and every later proxy transition) settles. Two ways a main-process fetcher
// can escape that fence, both audited here:
//   1. a `net.fetch` / `net.request` that names another `session` or `partition`
//   2. a `<session>.fetch(` on a `session.fromPartition(...)` session
// Known pre-existing gap outside this repo's reach: electron-updater runs on its own partition.
//
// Rule 2 entries map a file to its expected number of non-`net` `.fetch(` calls. A count change
// means a call site was added, removed, or moved: re-audit the file and update the count.
const AUDITED_NON_NET_FETCH_CALLS = new Map<string, number>([
  // Isolated cookie-jar session, proxied by createOpenCodeRequestSession before any request.
  ['main/rate-limits/opencode-go-usage-fetcher.ts', 2],
  // Isolated cookie-jar session that does NOT apply the proxy — a pre-existing gap, not a
  // regression: no proxy has ever reached this partition. Keep it listed so it stays visible.
  ['main/rate-limits/minimax-request-context.ts', 2],
  // Injected HttpClient, not a session: resolves to net.fetch on defaultSession
  // (main/host/electron-http-client.ts) or to the global-fetch-audited Node fallback.
  ['main/jira/authenticated-request.ts', 1]
])

// `globalThis.fetch` / `global.fetch` belong to global-fetch-call-site-audit.test.ts.
// `\s*` before `(`: the formatter never emits `net.fetch (url)`, but an unformatted call must not
// be a hole in a guard whose whole job is to fail on the call nobody reviewed.
const FETCH_CALL = /\.fetch\s*\(/g
const RECEIVER_IDENTIFIER = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*$/
const DEFAULT_SESSION_RECEIVERS = new Set(['net', 'globalThis', 'global'])
const NET_REQUEST_CALL = /(?<![.\w$])net\.(?:fetch|request)\s*\(/g
// Matches `{ session: x }` and the `{ url, session }` shorthand both `net.request` overloads take.
const SESSION_SCOPED_OPTION = /(?:^|[{,\s])(?:session|partition)\s*[:,}]/

/** Text between the call's parentheses, skipping string bodies so quoted parens don't unbalance. */
function callArgumentText(content: string, callEnd: number): string {
  let depth = 0
  let quote: string | null = null
  for (let index = callEnd - 1; index < content.length; index += 1) {
    const char = content[index]!
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return content.slice(callEnd, index)
      }
    }
  }
  return content.slice(callEnd)
}

function auditedSourceFiles(mainRoot: string): { file: string; content: string }[] {
  const files: { file: string; content: string }[] = []
  for (const entry of readdirSync(mainRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue
    }
    if (
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.test-fixtures.ts') ||
      entry.name.endsWith('.d.ts')
    ) {
      continue
    }
    const filePath = join(entry.parentPath, entry.name)
    files.push({
      file: `main/${relative(mainRoot, filePath).split(sep).join('/')}`,
      content: readFileSync(filePath, 'utf8')
    })
  }
  return files
}

describe('proxy-guarded fetch call-site audit (main)', () => {
  const sources = auditedSourceFiles(__dirname)

  it('keeps every net.fetch/net.request on the guarded default session', () => {
    const offenders: string[] = []
    for (const { file, content } of sources) {
      for (const match of content.matchAll(NET_REQUEST_CALL)) {
        const args = callArgumentText(content, match.index + match[0].length)
        if (SESSION_SCOPED_OPTION.test(args)) {
          offenders.push(`${file}:${content.slice(0, match.index).split('\n').length}`)
        }
      }
    }
    expect(
      offenders.sort(),
      'This request names its own session/partition, so it is not covered by ' +
        'installElectronProxyRequestGuard(session.defaultSession) and startup never applies the ' +
        'persisted proxy to it. Either drop the option, or apply the proxy to that session ' +
        'yourself (see main/rate-limits/opencode-go-request-session.ts) and allowlist it here.'
    ).toEqual([])
  })

  it('keeps every non-default-session fetcher audited with its expected count', () => {
    const found = new Map<string, number>()
    for (const { file, content } of sources) {
      const hits = [...content.matchAll(FETCH_CALL)].filter((match) => {
        const receiver = RECEIVER_IDENTIFIER.exec(content.slice(0, match.index))?.[1]
        // A chained (`session.fromPartition(...).fetch(`) or member (`ctx.session.fetch(`)
        // receiver has no bare trailing identifier, and is never the default session.
        return receiver === undefined || !DEFAULT_SESSION_RECEIVERS.has(receiver)
      }).length
      if (hits > 0) {
        found.set(file, hits)
      }
    }

    const drifted = [...found]
      .filter(([file, count]) => AUDITED_NON_NET_FETCH_CALLS.get(file) !== count)
      .map(([file, count]) => `${file}: found ${count} call(s)`)
      .sort()
    expect(
      drifted,
      'A session.fromPartition(...) session is not covered by ' +
        'installElectronProxyRequestGuard(session.defaultSession), so nothing holds its requests ' +
        'until the proxy lands and startup never applies the proxy to it. Apply the proxy to that ' +
        'session yourself (see main/rate-limits/opencode-go-request-session.ts), then update ' +
        'AUDITED_NON_NET_FETCH_CALLS.'
    ).toEqual([])

    const stale = [...AUDITED_NON_NET_FETCH_CALLS.keys()].filter((file) => !found.has(file)).sort()
    expect(stale, 'Remove audited entries whose .fetch( calls are gone.').toEqual([])
  })
})
