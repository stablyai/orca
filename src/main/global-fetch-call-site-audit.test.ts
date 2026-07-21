import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Global fetch (bare or via globalThis/global — unlike Electron's net.fetch)
// goes through Node's bundled undici, which can crash the whole process when
// an unread response body pauses the HTTP/1 parser and the peer closes the
// socket (nodejs/undici#5360, orca#8695). This applies to every Node process
// we ship: Electron main, the CLI, and the SSH relay.
//
// Each entry below maps an audited file to its expected number of matching
// lines. Real call sites must consume or cancel the body on every path,
// including !response.ok (see main/lib/unread-response-body.ts). A count
// change means a call site was added, removed, or moved: re-audit the file
// and update the count.
const AUDITED_GLOBAL_FETCH_LINES = new Map<string, number>([
  // HTTP call sites — body consumed or cancelled on every path, including !ok
  ['main/azure-devops/azure-devops-api-request.ts', 1],
  ['main/bitbucket/client.ts', 1],
  ['main/gitea/client.ts', 1],
  ['main/orca-profiles/profile-cloud-client.ts', 1],
  ['main/orca-profiles/profile-cloud-org-members-client.ts', 1],
  ['main/rate-limits/codex-fetcher.ts', 3],
  ['main/runtime/relay/relay-http-client.ts', 2],
  ['main/source-control/hosted-review-api-request.ts', 1],
  ['main/speech/openai-transcription-client.ts', 1],
  // fetch appears only inside injected-page script source strings, not as a
  // call this process makes
  ['main/amp/hook-service.ts', 1],
  ['main/opencode/hook-service.ts', 1],
  ['main/pi/agent-status-extension-source.ts', 1],
  // local identifiers named `fetch` (git fetch), not HTTP
  ['main/ipc/worktree-remote.ts', 2],
  ['relay/git-handler.ts', 1],
  // fetch mentioned only in a comment
  ['main/ipc/feedback.ts', 1]
])

// A line is a hit when it calls bare `fetch(` or touches `globalThis.fetch` /
// `global.fetch` in any way (call, alias, fallback like `input.fetch ??
// globalThis.fetch`). `typeof globalThis.fetch` type annotations are exempt.
const GLOBAL_FETCH_LINE = /(^|[^.\w])fetch\(|(?<!typeof )\bglobal(This)?\.fetch\b/

const SCANNED_ROOTS = ['main', 'cli', 'relay']

function globalFetchLineCounts(srcRoot: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const root of SCANNED_ROOTS) {
    for (const entry of readdirSync(join(srcRoot, root), {
      recursive: true,
      withFileTypes: true
    })) {
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
      const content = readFileSync(filePath, 'utf8')
      if (!GLOBAL_FETCH_LINE.test(content)) {
        continue
      }
      const hits = content.split('\n').filter((line) => GLOBAL_FETCH_LINE.test(line)).length
      if (hits > 0) {
        counts.set(relative(srcRoot, filePath).split(sep).join('/'), hits)
      }
    }
  }
  return counts
}

describe('global fetch call-site audit (main, cli, relay)', () => {
  it('keeps every global-fetch line audited with its expected count', () => {
    const found = globalFetchLineCounts(join(__dirname, '..'))

    const drifted = [...found]
      .filter(([file, count]) => AUDITED_GLOBAL_FETCH_LINES.get(file) !== count)
      .map(([file, count]) => `${file}: found ${count} line(s)`)
      .sort()
    expect(
      drifted,
      'Global fetch (bare, globalThis.fetch, or global.fetch) uses undici, ' +
        'where an unread response body can crash the whole process (orca#8695). ' +
        'New or moved call sites must either use Electron net.fetch or consume/' +
        'cancel the response body on ALL paths (cancelUnreadResponseBody in ' +
        'main/lib/unread-response-body.ts), then update AUDITED_GLOBAL_FETCH_LINES.'
    ).toEqual([])

    const stale = [...AUDITED_GLOBAL_FETCH_LINES.keys()].filter((file) => !found.has(file)).sort()
    expect(stale, 'Remove audited entries whose global-fetch lines are gone.').toEqual([])
  })
})
