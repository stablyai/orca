import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as CodexFsUtils from '../../../codex-accounts/fs-utils'

const { homedirMock, registrationTestState } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  registrationTestState: { failAtomicWrite: false }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

vi.mock('../../../codex-accounts/fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexFsUtils>()
  return {
    ...actual,
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => {
      if (registrationTestState.failAtomicWrite) {
        throw new Error('injected atomic write failure')
      }
      return actual.writeFileAtomically(...args)
    }
  }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

// Registration tables written by Codex 0.145 marketplace and plugin additions.
const MARKETPLACE_TABLE = [
  '[marketplaces.ponytail]',
  'source_type = "git"',
  'source = "https://github.com/DietrichGebert/ponytail.git"',
  'ref_name = "main"',
  'last_updated = "2026-01-05T10:00:00Z"',
  'last_revision = "aaaa111"'
].join('\n')

const PLUGIN_TABLE = ['[plugins."ponytail@ponytail"]', 'enabled = true', 'version = "4.8.4"'].join(
  '\n'
)

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-registration-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-registration-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  registrationTestState.failAtomicWrite = false
  if (homedir() !== tmpHome) {
    throw new Error('node:os homedir mock is not active; refusing to touch the real ~/.codex')
  }
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

function systemHomeDir(): string {
  return join(tmpHome, '.codex')
}

function runtimeHomeDir(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function baselinePath(homePath = runtimeHomeDir()): string {
  return join(homePath, '.orca-config-settings-baseline.json')
}

function writeSystemConfig(content: string, homePath = systemHomeDir()): void {
  mkdirSync(homePath, { recursive: true })
  writeFileSync(join(homePath, 'config.toml'), content, 'utf-8')
}

function readSystemConfig(homePath = systemHomeDir()): string {
  return readFileSync(join(homePath, 'config.toml'), 'utf-8')
}

function readRuntimeConfig(homePath = runtimeHomeDir()): string {
  return readFileSync(join(homePath, 'config.toml'), 'utf-8')
}

function simulateCodexRegistrationWrite(block: string, homePath = runtimeHomeDir()): void {
  mkdirSync(homePath, { recursive: true })
  const configPath = join(homePath, 'config.toml')
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  writeFileSync(configPath, `${existing.trimEnd()}\n\n${block}\n`, 'utf-8')
}

function mirrorTwice(): void {
  syncSystemConfigIntoManagedCodexHome()
  syncSystemConfigIntoManagedCodexHome()
}

describe('codex plugin registration survives the managed-home mirror', () => {
  it('honors a canonical removal instead of resurrecting the registration', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(`${MARKETPLACE_TABLE}\n\n${PLUGIN_TABLE}`)
    mirrorTwice()
    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')

    writeSystemConfig('model = "gpt-5"\n')
    mirrorTwice()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).not.toContain('marketplaces.ponytail')
    expect(readRuntimeConfig()).not.toContain('ponytail@ponytail')
  })

  // Include absence as the third enabled state so both sides can diverge.
})

describe('codex marketplace refresh metadata promotion', () => {
  // Date.parse rolls impossible dates forward, potentially making them look newer.

  it('preserves the managed config and its baseline when the promotion write fails', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()
    simulateCodexRegistrationWrite(MARKETPLACE_TABLE)
    const runtimeBeforeFailure = readRuntimeConfig()
    const baselineBeforeFailure = readFileSync(baselinePath(), 'utf-8')

    registrationTestState.failAtomicWrite = true
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(readRuntimeConfig()).toBe(runtimeBeforeFailure)
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(baselineBeforeFailure)

    registrationTestState.failAtomicWrite = false
    mirrorTwice()

    expect(readSystemConfig()).toContain('[marketplaces.ponytail]')
    expect(readRuntimeConfig()).toContain('[marketplaces.ponytail]')
  })
})
