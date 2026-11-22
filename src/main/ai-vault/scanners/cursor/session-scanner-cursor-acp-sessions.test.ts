import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots } from '../../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeAcpSession(configDir: string, sessionId: string, activity: Date) {
  const sessionDir = join(configDir, 'acp-sessions', sessionId)
  await mkdir(sessionDir, { recursive: true })
  // Cursor's own writer: schemaVersion, absolute cwd, optional title.
  await writeFile(
    join(sessionDir, 'meta.json'),
    JSON.stringify({ schemaVersion: 1, cwd: '/Users/ada/work', title: `Chat ${sessionId}` })
  )
  // Not SQLite: listing must never open store.db.
  await writeFile(join(sessionDir, 'store.db'), 'opaque')
  await utimes(join(sessionDir, 'store.db'), activity, activity)
  return join(sessionDir, 'store.db')
}

describe('Cursor ACP sessions in Session History', () => {
  it('lists the sessions native Chat owns, by meta.json under its cwd, dated by store.db', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-acp-'))
    tempRoots.push(root)
    const configDir = join(root, 'cursor-config')
    const owned = '6f1c2a54-0d4e-4c55-9a7e-2b8f0c1d3e4a'
    const storePath = await writeAcpSession(configDir, owned, new Date('2026-11-20T09:30:00.000Z'))
    // Another ACP client's session, or a chat naming task's: no Orca chat opens it.
    await writeAcpSession(
      configDir,
      'aaaaaaaa-0000-4000-8000-000000000000',
      new Date('2026-11-22T08:00:00.000Z')
    )
    const roots = {
      ...isolatedScanRoots(root),
      cursorAcpSessions: { sessionIds: [owned], configDirs: [configDir], inWsl: false }
    }

    for (const scope of [{}, { scopePaths: ['/Users/ada/work'], scopeOnly: true }]) {
      const result = await scanAiVaultSessions({ ...roots, ...scope })
      expect(result.sessions).toEqual([
        expect.objectContaining({
          agent: 'cursor',
          sessionId: owned,
          cwd: '/Users/ada/work',
          title: `Chat ${owned}`,
          modifiedAt: '2026-11-20T09:30:00.000Z',
          filePath: storePath,
          resumeCommand: ''
        })
      ])
    }

    const later = new Date('2026-11-21T12:00:00.000Z')
    await utimes(storePath, later, later)
    const rescanned = await scanAiVaultSessions(roots)
    expect(rescanned.sessions[0]?.modifiedAt).toBe('2026-11-21T12:00:00.000Z')
  })
})
