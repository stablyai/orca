import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeOpenCodeUsageDatabase } from './opencode-usage-sqlite-fixture'
import { normalizeOpenCodeUsagePersistedDatabases } from './persisted-database-normalization'
import { scanOpenCodeUsageDatabases } from './scanner'
import type { OpenCodeUsagePersistedDatabase } from './types'

function stripSessions(
  databases: OpenCodeUsagePersistedDatabase[],
  path: string
): OpenCodeUsagePersistedDatabase[] {
  return normalizeOpenCodeUsagePersistedDatabases(
    databases.map((database) => {
      const copy = { ...database }
      if (database.path === path) {
        Reflect.deleteProperty(copy, 'sessions')
      }
      return copy
    })
  )
}

function inputTokens(result: Awaited<ReturnType<typeof scanOpenCodeUsageDatabases>>): number {
  return result.sessions.reduce((sum, session) => sum + session.totalInputTokens, 0)
}

describe('scanOpenCodeUsageDatabases with a cached record missing its sessions', () => {
  let dataRoot: string
  let openCodeDir: string

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'orca-opencode-usage-damaged-'))
    openCodeDir = join(dataRoot, 'opencode')
    vi.stubEnv('XDG_DATA_HOME', dataRoot)
    vi.stubEnv('OPENCODE_DB', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dataRoot, { recursive: true, force: true })
  })

  function writeDatabase(fileName: string, sessions: [string, number][]): string {
    const path = join(openCodeDir, fileName)
    writeOpenCodeUsageDatabase(path, {
      generation: 'v1',
      legacySessions: sessions.map(([id, tokensInput]) => ({
        id,
        directory: '/workspace/repo',
        tokensInput
      }))
    })
    return path
  }

  it('frees its sessions for a backup once the database is deleted', async () => {
    const live = writeDatabase('opencode.db', [['session-1', 1000]])
    writeDatabase('opencode-backup.db', [
      ['session-1', 400],
      ['session-9', 50]
    ])
    const first = await scanOpenCodeUsageDatabases([], [])
    expect(inputTokens(first)).toBe(1050)

    rmSync(live)
    const second = await scanOpenCodeUsageDatabases(
      [],
      stripSessions(first.processedDatabases, live)
    )

    expect(inputTokens(second)).toBe(450)
  })
})
