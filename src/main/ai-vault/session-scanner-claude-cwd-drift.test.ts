import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions — Claude cwd drift', () => {
  it('resumes a Claude session from its start directory even after the cwd drifts', async () => {
    // Regression for #9361: Claude stores transcripts under
    // ~/.claude/projects/<slug-of-start-dir>/, and `claude --resume <id>` only
    // looks in the project dir derived from the *current* cwd. If the session
    // changed directory mid-run, resuming with the last-seen cwd fails with
    // "No conversation found". The session's representative cwd must stay the
    // start directory.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-cwd-drift-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'drift-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'drift-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/repo/app',
          gitBranch: 'main',
          message: { role: 'user', content: 'start here' }
        },
        {
          type: 'user',
          sessionId: 'drift-session',
          timestamp: '2026-05-01T10:05:00.000Z',
          cwd: '/repo/app/services/api',
          gitBranch: 'main',
          message: { role: 'user', content: 'now in a subdirectory' }
        }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const claude = result.sessions.find((session) => session.agent === 'claude')
    expect(claude).toMatchObject({
      sessionId: 'drift-session',
      cwd: '/repo/app',
      resumeCommand: "cd '/repo/app' && claude --resume 'drift-session'"
    })
  })
})
