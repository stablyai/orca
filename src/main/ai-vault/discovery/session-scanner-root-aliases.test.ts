import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../session-scanner'
import {
  isolatedScanRoots,
  writeJsonlFile
} from '../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions — Claude root aliases', () => {
  it('reads a transcript once when profile homes link their projects to the shared folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-root-alias-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const transcript = join(roots.claudeProjectsDir, '-Users-ada-repo', 'shared.jsonl')
    await writeJsonlFile(transcript, [
      {
        type: 'user',
        sessionId: 'shared',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/Users/ada/repo',
        message: { role: 'user', content: 'hello' }
      }
    ])
    await writeJsonlFile(join(root, 'own', 'projects', '-Users-ada-repo', 'own.jsonl'), [
      {
        type: 'user',
        sessionId: 'own',
        timestamp: '2026-05-02T10:00:00.000Z',
        cwd: '/Users/ada/repo',
        message: { role: 'user', content: 'separate history' }
      }
    ])
    // Profile setup links each account's projects folder: a junction on Windows, a symlink elsewhere.
    const profileDirs = [join(root, 'a', 'projects'), join(root, 'b', 'projects')]
    for (const dir of profileDirs) {
      await mkdir(dirname(dir), { recursive: true })
      await symlink(roots.claudeProjectsDir, dir, process.platform === 'win32' ? 'junction' : 'dir')
    }

    const result = await scanAiVaultSessions({
      ...roots,
      claudeProfileProjectsDirs: [...profileDirs, join(root, 'own', 'projects')],
      platform: 'darwin'
    })

    expect(
      result.sessions
        .filter((session) => session.agent === 'claude')
        .map((session) => [session.sessionId, session.filePath])
        .sort()
    ).toEqual([
      ['own', join(root, 'own', 'projects', '-Users-ada-repo', 'own.jsonl')],
      ['shared', transcript]
    ])
  })
})
