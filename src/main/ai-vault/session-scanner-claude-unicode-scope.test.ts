import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { resetProjectDirCwdCacheForTests } from './session-scanner-scope-discovery'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  resetProjectDirCwdCacheForTests()
})

// Claude names its project dir after the cwd with every non-alphanumeric run
// mapped to '-', so an NFD workspace path yields 2-3x the dashes of Claude's
// NFC-derived name and can never prefix-match it.
function claudeProjectDirName(cwd: string): string {
  return cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-')
}

describe('scanAiVaultSessions — non-ASCII scope paths', () => {
  it('lists Claude sessions when the workspace path is NFD and the transcript is NFC', async () => {
    // Regression for #10832: macOS hands Orca decomposed (NFD) workspace paths
    // while Claude Code writes NFC in both the project dir name and the recorded
    // cwd, so every workspace with non-ASCII path segments listed zero sessions.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-nfc-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    const workspaceNfc = '/Users/ada/내 드라이브/한국농어촌공사'
    const workspaceNfd = workspaceNfc.normalize('NFD')
    expect(workspaceNfd).not.toBe(workspaceNfc)

    const projectDir = join(roots.claudeProjectsDir, claudeProjectDirName(workspaceNfc))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'korean-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'korean-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: workspaceNfc,
          gitBranch: 'main',
          message: { role: 'user', content: '안녕하세요' }
        }
      ])
    )

    // A newer ASCII session plus limit:1 exhausts the recency cap, so the Korean
    // session can only surface through scope discovery — the path under test.
    await mkdir(join(roots.claudeProjectsDir, '-Users-ada-other'), { recursive: true })
    await writeFile(
      join(roots.claudeProjectsDir, '-Users-ada-other', 'recent-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'recent-session',
          timestamp: '2026-06-01T10:00:00.000Z',
          cwd: '/Users/ada/other',
          gitBranch: 'main',
          message: { role: 'user', content: 'newer' }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 1,
      scopePaths: [workspaceNfd]
    })

    expect(result.sessions.map((session) => session.sessionId)).toContain('korean-session')
  })
})
