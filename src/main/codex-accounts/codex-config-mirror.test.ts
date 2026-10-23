import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import { API_PROVIDER_ACCOUNT_FILE, saveApiProviderAccount } from '../api-provider-account'

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

  it('leaves a WSL home to launch prep instead of running its blocking ownership check', () => {
    const assertManagedHomePath = vi.fn((path: string) => path)
    const wslMirror = new CodexConfigMirror(
      { getSettings: () => getDefaultSettings(testState.fakeHomeDir) },
      assertManagedHomePath
    )

    wslMirror.safeSyncIntoManagedHome(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\codex-accounts\\acct\\home',
      undefined,
      'acct'
    )

    expect(assertManagedHomePath).not.toHaveBeenCalled()
  })

  it('adds the guard without touching settings already in the managed home', () => {
    writeFileSync(join(managedHomePath, 'config.toml'), 'model = "gpt-5"\n')

    mirror.safeSyncIntoManagedHome(managedHomePath, undefined, 'acct')

    expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
  })
})

describe('Codex API account mirror isolation', () => {
  it('refuses a missing sidecar without promoting API settings into System default', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-api-mirror-'))
    testState.fakeHomeDir = root
    try {
      const systemHome = join(root, '.codex')
      const managedHomePath = join(root, 'account')
      mkdirSync(systemHome)
      mkdirSync(managedHomePath)
      const canonical = 'model = "subscription-model"\nmodel_provider = "openai"\n'
      writeFileSync(join(systemHome, 'config.toml'), canonical)
      const settings = getDefaultSettings(root)
      const mirror = new CodexConfigMirror({ getSettings: () => settings }, (path) => path)
      mirror.safeSyncIntoManagedHome(managedHomePath, undefined, 'acct')
      const apiProvider = saveApiProviderAccount(
        managedHomePath,
        {
          label: 'API',
          baseUrl: 'https://provider.test/v1',
          model: 'api-model',
          apiKey: 'private-api-key'
        },
        'codex'
      )
      settings.codexManagedAccounts = [
        {
          id: 'acct',
          email: '',
          apiProvider,
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
      mirror.safeSyncToManagedHomes()
      const runtimeBefore = readFileSync(join(managedHomePath, 'config.toml'), 'utf8')
      expect(runtimeBefore).toContain('orca_api_account')
      rmSync(join(managedHomePath, API_PROVIDER_ACCOUNT_FILE))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        mirror.safeSyncToManagedHomes()
        mirror.safeSyncIntoManagedHome(managedHomePath, undefined, 'acct')
        expect(readFileSync(join(systemHome, 'config.toml'), 'utf8')).toBe(canonical)
        expect(readFileSync(join(managedHomePath, 'config.toml'), 'utf8')).toBe(runtimeBefore)
        expect(warning).toHaveBeenCalled()
      } finally {
        warning.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
