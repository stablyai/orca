import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'

const testState = vi.hoisted(() => ({ fakeHomeDir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('tests pass explicit homes')
    }
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

import { CodexConfigMirror } from './codex-config-mirror'

const OVERRIDE_LINE = 'daemon_auto_start = false # orca: CODEX_HOME too long for the daemon socket'

describe('CodexConfigMirror without ~/.codex/config.toml', () => {
  let root: string
  let managedHomePath: string
  let mirror: CodexConfigMirror

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-accounts-mirror-'))
    testState.fakeHomeDir = join(root, 'user-home')
    mkdirSync(testState.fakeHomeDir)
    // Long enough to exceed sun_path on every platform, like a real account home.
    managedHomePath = join(root, 'a'.repeat(80), 'home')
    mkdirSync(managedHomePath, { recursive: true })
    const settings = {
      ...getDefaultSettings(testState.fakeHomeDir),
      codexManagedAccounts: [
        {
          id: 'acct',
          email: 'user@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }
    mirror = new CodexConfigMirror({ getSettings: () => settings }, (path) => path)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('still guards every managed home against the daemon socket limit', () => {
    mirror.safeSyncToManagedHomes()

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    expect(existsSync(join(testState.fakeHomeDir, '.codex'))).toBe(false)
  })

  it('adds the guard without touching settings already in the managed home', () => {
    writeFileSync(join(managedHomePath, 'config.toml'), 'model = "gpt-5"\n')

    mirror.safeSyncIntoManagedHome(managedHomePath, undefined, 'acct')

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
  })
})
