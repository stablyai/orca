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

// Claude's own rule, deliberately spelled out rather than imported from the
// production encoder: these tests exist to catch Orca drifting away from how
// Claude actually names its directories, which a shared helper would hide.
// Claude maps every non-alphanumeric character of the raw cwd to '-', keeping
// case, and records the cwd it was launched with (NFC on macOS).
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

  it('lists Claude sessions for a Windows workspace whose path has uppercase segments', async () => {
    // Claude derives the dir name from the raw cwd, so it keeps 'C--Users-Ada-repo'.
    // Encoding from the lowercased comparison key produced 'c--users-ada-repo',
    // which never matched — scoped discovery was dead on Windows entirely.
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
