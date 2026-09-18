import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'

const testState = {
  fakeHomeDir: '',
  previousConfigDir: undefined as string | undefined
}

vi.mock('electron', () => ({ app: { getPath: () => testState.fakeHomeDir } }))

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-rate-limit-path-'))
  testState.previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  if (testState.previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = testState.previousConfigDir
  }
  testState.fakeHomeDir = ''
})

describe('Claude runtime auth path materialization', () => {
  it('does not create the config directory while preparing a background usage fetch', async () => {
    const settings = {
      ...getDefaultSettings(testState.fakeHomeDir),
      disabledTuiAgents: ['claude'] as const,
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn()
    }
    const service = new ClaudeRuntimeAuthService(store as never)

    const preparation = await service.prepareForRateLimitFetch()

    expect(preparation.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    expect(preparation.provenance).toBe('system')
    expect(existsSync(preparation.configDir)).toBe(false)
  })
})
