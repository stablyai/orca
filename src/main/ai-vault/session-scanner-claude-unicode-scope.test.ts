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

// Model Claude independently so a production encoder regression cannot change the fixture to match.
function claudeProjectDirName(cwd: string): string {
  return cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-')
}

describe('scanAiVaultSessions — non-ASCII scope paths', () => {
  it('lists Claude sessions when the workspace path is NFD and the transcript is NFC', async () => {
    // macOS workspace paths may be NFD while Claude records and encodes NFC (#10832).
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

    // Exhaust the recency cap so only scoped discovery can find the Korean path.
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

  it('lists Claude sessions for a Windows workspace whose path has uppercase segments', async () => {
    // Claude preserves path case in bucket names; a lowercased comparison key cannot reproduce them.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-win-scope-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    const workspace = 'C:\\Users\\Ada\\repo'
    const projectDir = join(roots.claudeProjectsDir, claudeProjectDirName(workspace))
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'windows-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'windows-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: workspace,
          gitBranch: 'main',
          message: { role: 'user', content: 'hello' }
        }
      ])
    )
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
      platform: 'win32',
      limit: 1,
      scopePaths: [workspace]
    })

    expect(result.sessions.map((session) => session.sessionId)).toContain('windows-session')
  })
})
