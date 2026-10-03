import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookFlagSync from './codex-hook-flag-sync'

const { known } = vi.hoisted(() => {
  const known: { current: { version: string | null; failure: string | null } | null } = {
    current: null
  }
  return { known }
})
vi.mock('./codex-hook-flag-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookFlagSync>()),
  getKnownCodexHookFlag: () => known.current
}))

import { CodexHookService } from './codex-hook-service-implementation'
import { createCodexHookFlagTable, publishCodexHookFlagEntry } from './codex-hook-flag-table'

describe('Codex hook status', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-status-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    known.current = null
    createCodexHookFlagTable()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(userData, { recursive: true, force: true })
  })

  it('reads the published table, so a separate CLI process reports what the app published', () => {
    expect(new CodexHookService().getStatus().state).toBe('not_installed')

    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })

    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'installed',
      detail: 'Carried as a session flag for codex-cli 1.0.0'
    })
  })

  it("reports the entry for this process's codex version, not one left by an older Codex", () => {
    publishCodexHookFlagEntry({ codexVersion: 'codex-cli 1.0.0', flag: 'hooks={}', noDaemon: true })

    known.current = { version: 'codex-cli 2.0.0', failure: 'codex-cli 2.0.0 does not trust it' }
    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'not_installed',
      detail: 'codex-cli 2.0.0 does not trust it'
    })

    known.current = { version: 'codex-cli 1.0.0', failure: null }
    expect(new CodexHookService().getStatus().state).toBe('installed')
  })
})
