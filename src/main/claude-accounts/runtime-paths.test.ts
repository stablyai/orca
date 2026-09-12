import {
  cleanupRuntimeAuthTestState,
  createElectronMock,
  createKeychainMock,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => createKeychainMock())

describe('ClaudeRuntimePathResolver', () => {
  const originalConfigDirEnv = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    resetRuntimeAuthTestState()
    delete process.env.CLAUDE_CONFIG_DIR
    // Why: the shared harness pre-creates ~/.claude; these tests assert it is NOT created,
    // so the assertions are vacuous unless the directory starts absent.
    rmSync(join(testState.fakeHomeDir, '.claude'), { recursive: true, force: true })
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
    if (originalConfigDirEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDirEnv
    }
  })

  it('resolves the default config directory without creating it', async () => {
    const configDir = join(testState.fakeHomeDir, '.claude')
    expect(existsSync(configDir)).toBe(false)

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(configDir)
    expect(paths.credentialsPath).toBe(join(configDir, '.credentials.json'))
    expect(paths.configPath).toBe(join(testState.fakeHomeDir, '.claude.json'))
    expect(paths.envPatch).toEqual({})
    expect(existsSync(configDir)).toBe(false)
  })

  it('resolves an inherited CLAUDE_CONFIG_DIR without creating it', async () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude-home')
    process.env.CLAUDE_CONFIG_DIR = inherited
    expect(existsSync(inherited)).toBe(false)

    const { ClaudeRuntimePathResolver } = await import('./runtime-paths')
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(inherited)
    expect(paths.configPath).toBe(join(inherited, '.claude.json'))
    expect(paths.envPatch).toEqual({ CLAUDE_CONFIG_DIR: inherited })
    expect(existsSync(inherited)).toBe(false)
  })

  it('does not create the Claude config directory when a rate-limit fetch finds no managed account', async () => {
    const configDir = join(testState.fakeHomeDir, '.claude')
    const store = createStore(
      createSettings({ claudeManagedAccounts: [], activeClaudeManagedAccountId: null })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForRateLimitFetch()

    expect(preparation.configDir).toBe(configDir)
    expect(existsSync(configDir)).toBe(false)
  })

  it('still creates the parent directory when credentials are actually written', async () => {
    const configDir = join(testState.fakeHomeDir, '.claude')
    const credentialsPath = join(configDir, '.credentials.json')
    expect(existsSync(configDir)).toBe(false)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store()) as unknown as {
      writeRuntimeCredentials: (contents: string) => void
    }
    service.writeRuntimeCredentials('{"claudeAiOauth":{"accessToken":"token"}}')

    expect(existsSync(configDir)).toBe(true)
    expect(readFileSync(credentialsPath, 'utf-8')).toBe('{"claudeAiOauth":{"accessToken":"token"}}')
  })

  it('still creates the parent directory when the runtime config file is written', async () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude-home')
    process.env.CLAUDE_CONFIG_DIR = inherited
    // Why absent: this is the writer half of the claim that lets the resolver stop
    // creating the dir. Pre-creating it here would leave `writeJson`'s own mkdir unpinned.
    expect(existsSync(inherited)).toBe(false)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store()) as unknown as {
      writeRuntimeOauthAccount: (account: unknown) => boolean
    }

    expect(service.writeRuntimeOauthAccount({ emailAddress: 'user@example.com' })).toBe(true)
    expect(existsSync(inherited)).toBe(true)
    expect(JSON.parse(readFileSync(join(inherited, '.claude.json'), 'utf-8')).oauthAccount).toEqual(
      {
        emailAddress: 'user@example.com'
      }
    )
  })

  it('preserves unrelated keys when updating an existing runtime config file', async () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude-home')
    process.env.CLAUDE_CONFIG_DIR = inherited
    mkdirSync(inherited, { recursive: true })
    writeFileSync(join(inherited, '.claude.json'), '{"theme":"dark"}\n', { mode: 0o600 })

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store()) as unknown as {
      writeRuntimeOauthAccount: (account: unknown) => boolean
    }

    expect(service.writeRuntimeOauthAccount({ emailAddress: 'user@example.com' })).toBe(true)
    const written = JSON.parse(readFileSync(join(inherited, '.claude.json'), 'utf-8'))
    expect(written.oauthAccount).toEqual({ emailAddress: 'user@example.com' })
    expect(written.theme).toBe('dark')
  })
})

function store(): never {
  return createStore(
    createSettings({ claudeManagedAccounts: [], activeClaudeManagedAccountId: null })
  ) as never
}
