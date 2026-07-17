import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Bare global fetch (unlike Electron's net.fetch) goes through Node's bundled
// undici, which crashes the whole main process when an unread response body
// pauses the HTTP/1 parser and the peer closes the socket (nodejs/undici#5360,
// orca#8695). Every file below has been audited: real call sites consume or
// cancel the body on all paths (see lib/unread-response-body.ts).
const AUDITED_BARE_FETCH_FILES = new Set([
  // HTTP call sites — body consumed or cancelled on every path, including !ok
  'azure-devops/azure-devops-api-request.ts',
  'bitbucket/client.ts',
  'gitea/client.ts',
  'orca-profiles/profile-cloud-client.ts',
  'orca-profiles/profile-cloud-org-members-client.ts',
  'rate-limits/codex-fetcher.ts',
  'source-control/hosted-review-api-request.ts',
  'speech/openai-transcription-client.ts',
  // fetch appears only inside injected-page script source strings, not as a
  // main-process call
  'amp/hook-service.ts',
  'opencode/hook-service.ts',
  'pi/agent-status-extension-source.ts',
  // local callback named `fetch` (git fetch), not HTTP
  'ipc/worktree-remote.ts'
])

const BARE_FETCH_PATTERN = /(^|[^.\w])fetch\(/

function bareFetchFiles(root: string): string[] {
  const hits = new Set<string>()
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) {
      continue
    }
    const filePath = join(entry.parentPath, entry.name)
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue
      }
      if (BARE_FETCH_PATTERN.test(line)) {
        hits.add(relative(root, filePath).split(sep).join('/'))
        break
      }
    }
  }
  return [...hits].sort()
}

describe('main-process bare global fetch audit', () => {
  it('keeps every bare fetch( call site in the audited allowlist', () => {
    const found = bareFetchFiles(__dirname)
    const unaudited = found.filter((file) => !AUDITED_BARE_FETCH_FILES.has(file))
    expect(
      unaudited,
      'New bare global fetch( call sites in the main process must either use ' +
        'Electron net.fetch or guarantee the response body is consumed/cancelled ' +
        'on ALL paths (cancelUnreadResponseBody in lib/unread-response-body.ts), ' +
        'then be added to AUDITED_BARE_FETCH_FILES. Unread bodies can crash the ' +
        'whole main process (orca#8695).'
    ).toEqual([])

    const stale = [...AUDITED_BARE_FETCH_FILES].filter((file) => !found.includes(file)).sort()
    expect(stale, 'Remove allowlist entries whose bare fetch( call sites are gone.').toEqual([])
  })
})
