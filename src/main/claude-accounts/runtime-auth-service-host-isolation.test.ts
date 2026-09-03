import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  expectedRuntimeConfigDir,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import {
  getActiveClaudeService,
  writeActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentialsForRuntime
} from './keychain'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', async () => ({
  ...(await vi.importActual<typeof import('./keychain')>('./keychain')), // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  ...createKeychainMock()
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

function snapshotDirectory(root: string): string {
  const entries: {
    contentHash?: string
    inode: string
    kind: string
    mtimeNs: string
    path: string
    target?: string
  }[] = []

  function visit(path: string): void {
    const stat = lstatSync(path, { bigint: true })
    const entry: (typeof entries)[number] = {
      inode: stat.ino.toString(),
      kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      mtimeNs: stat.mtimeNs.toString(),
      path: relative(root, path)
    }
    if (stat.isSymbolicLink()) {
      entry.target = readlinkSync(path)
    } else if (stat.isFile()) {
      entry.contentHash = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
    entries.push(entry)
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        visit(join(path, child))
      }
    }
  }

  visit(root)
  return JSON.stringify(entries.sort((left, right) => left.path.localeCompare(right.path)))
}

function createSystemCredentials(): string {
  const credentials = createClaudeCredentialsJson('system@example.com', 'system')
  writeFileSync(join(expectedRuntimeConfigDir(), '.credentials.json'), credentials, 'utf-8')
  testState.legacyKeychainCredentials = credentials
  return credentials
}

describe('ClaudeRuntimeAuthService host account isolation', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  it('routes an owned host account without writing shared runtime auth', async () => {
    const systemCredentials = createSystemCredentials()
    const managedCredentials = createClaudeCredentialsJson('a@example.com', 'account-a')
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-a', managedCredentials)
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', managedAuthPath, {
          email: 'a@example.com',
          managedAuthRuntime: 'host'
        })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    settings.activeClaudeManagedAccountId = 'account-a'
    await service.syncForCurrentSelection()
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.configDir).toBe(managedAuthPath)
    expect(preparation.envPatch).toEqual({
      CLAUDE_CONFIG_DIR: managedAuthPath,
      ORCA_CLAUDE_CONFIG_DIR: managedAuthPath
    })
    expect(preparation.stripAuthEnv).toBe(true)
    expect(readFileSync(join(expectedRuntimeConfigDir(), '.credentials.json'), 'utf-8')).toBe(
      systemCredentials
    )
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
    // The launch path no longer writes any credential store: the CLI owns the scoped item. The
    // credential is there because startup migration copied it once, not because launch bridges it.
    // Ablation: restoring the launch-path scoped write turns this red.
    expect(vi.mocked(writeActiveClaudeKeychainCredentials)).not.toHaveBeenCalled()
    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath)).toBe(
      managedCredentials
    )
    expect(vi.mocked(writeActiveClaudeKeychainCredentialsForRuntime)).not.toHaveBeenCalled()
  })

  it('uses the same absolute managed path spelling for env and scoped Keychain hashing', async () => {
    createSystemCredentials()
    const managedCredentials = createClaudeCredentialsJson('a@example.com', 'account-a')
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-a', managedCredentials)
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', managedAuthPath, { managedAuthRuntime: 'host' })
      ],
      activeClaudeManagedAccountId: 'account-a'
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const preparation = await new ClaudeRuntimeAuthService(store as never).prepareForClaudeLaunch()

    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBe(managedAuthPath)
    expect(preparation.envPatch.ORCA_CLAUDE_CONFIG_DIR).toBe(managedAuthPath)
    expect(getActiveClaudeService(managedAuthPath)).toBe(
      `Claude Code-credentials-${createHash('sha256').update(managedAuthPath).digest('hex').slice(0, 8)}`
    )
    expect(getActiveClaudeService(preparation.configDir)).toBe(
      getActiveClaudeService(managedAuthPath)
    )
  })

  it('leaves account A and its scoped item untouched when switching to account B', async () => {
    const systemCredentials = createSystemCredentials()
    const accountACredentials = createClaudeCredentialsJson('a@example.com', 'account-a')
    const accountBCredentials = createClaudeCredentialsJson('b@example.com', 'account-b')
    const managedAuthPathA = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-a', accountACredentials)
    )
    const managedAuthPathB = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-b', accountBCredentials)
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', managedAuthPathA, {
          email: 'a@example.com',
          managedAuthRuntime: 'host'
        }),
        createClaudeAccount('account-b', managedAuthPathB, {
          email: 'b@example.com',
          managedAuthRuntime: 'host'
        })
      ],
      activeClaudeManagedAccountId: null
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    settings.activeClaudeManagedAccountId = 'account-a'
    await service.syncForCurrentSelection()
    await service.prepareForClaudeLaunch()
    const accountASnapshot = snapshotDirectory(managedAuthPathA)
    const accountAScopedCredentials =
      testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPathA)

    settings.activeClaudeManagedAccountId = 'account-b'
    await service.syncForCurrentSelection()
    const preparationB = await service.prepareForClaudeLaunch()

    expect(preparationB.configDir).toBe(managedAuthPathB)
    expect(snapshotDirectory(managedAuthPathA)).toBe(accountASnapshot)
    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPathA)).toBe(
      accountAScopedCredentials
    )
    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPathB)).toBe(
      accountBCredentials
    )
    expect(readFileSync(join(expectedRuntimeConfigDir(), '.credentials.json'), 'utf-8')).toBe(
      systemCredentials
    )
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('is idempotent when the same host account is selected again', async () => {
    createSystemCredentials()
    writeFileSync(join(expectedRuntimeConfigDir(), 'CLAUDE.md'), 'shared instructions\n', 'utf-8')
    const managedCredentials = createClaudeCredentialsJson('a@example.com', 'account-a')
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(testState.userDataDir, 'account-a', managedCredentials)
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', managedAuthPath, { managedAuthRuntime: 'host' })
      ],
      activeClaudeManagedAccountId: 'account-a'
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    const firstPreparation = await service.prepareForClaudeLaunch()
    const firstSnapshot = snapshotDirectory(managedAuthPath)
    const firstScopedCredentials =
      testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath)
    const secondPreparation = await service.prepareForClaudeLaunch()

    expect(secondPreparation).toEqual(firstPreparation)
    expect(snapshotDirectory(managedAuthPath)).toBe(firstSnapshot)
    expect(testState.scopedKeychainCredentialsByConfigDir.get(managedAuthPath)).toBe(
      firstScopedCredentials
    )
  })

  it('refuses a host account outside the ownership root instead of routing it', async () => {
    createSystemCredentials()
    const outsideAuthPath = join(testState.fakeHomeDir, 'outside-claude-auth')
    mkdirSync(outsideAuthPath, { recursive: true })
    writeFileSync(join(outsideAuthPath, '.orca-managed-claude-auth'), 'account-outside\n', 'utf-8')
    writeFileSync(
      join(outsideAuthPath, '.credentials.json'),
      createClaudeCredentialsJson('outside@example.com', 'outside'),
      'utf-8'
    )
    writeFileSync(
      join(outsideAuthPath, 'oauth-account.json'),
      '{"accountUuid":"outside"}\n',
      'utf-8'
    )
    const managedAuthPath = realpathSync(outsideAuthPath)
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-outside', managedAuthPath, { managedAuthRuntime: 'host' })
      ],
      activeClaudeManagedAccountId: 'account-outside'
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const preparation = await new ClaudeRuntimeAuthService(store as never).prepareForClaudeLaunch()

    expect(preparation.configDir).toBe(expectedRuntimeConfigDir())
    expect(preparation.envPatch).toEqual({})
    expect(preparation.stripAuthEnv).toBe(true)
    expect(testState.scopedKeychainCredentialsByConfigDir.has(managedAuthPath)).toBe(false)
  })

  it('links shared Claude surfaces while keeping auth and identity per account', async () => {
    createSystemCredentials()
    const sharedResources = {
      'CLAUDE.md': 'shared instructions\n',
      'settings.json': '{"theme":"shared"}\n'
    }
    for (const [name, contents] of Object.entries(sharedResources)) {
      writeFileSync(join(expectedRuntimeConfigDir(), name), contents, 'utf-8')
    }
    for (const name of ['plugins', 'projects']) {
      mkdirSync(join(expectedRuntimeConfigDir(), name), { recursive: true })
      writeFileSync(join(expectedRuntimeConfigDir(), name, 'README.md'), `${name}\n`, 'utf-8')
    }
    const managedCredentials = createClaudeCredentialsJson('a@example.com', 'account-a')
    const managedOauthAccount = '{"accountUuid":"account-a"}\n'
    const managedAuthPath = realpathSync(
      createManagedClaudeAuth(
        testState.userDataDir,
        'account-a',
        managedCredentials,
        managedOauthAccount
      )
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-a', managedAuthPath, {
          managedAuthRuntime: 'host',
          email: 'a@example.com'
        })
      ],
      activeClaudeManagedAccountId: 'account-a'
    })
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => Object.assign(settings, updates))
    }
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    await new ClaudeRuntimeAuthService(store as never).prepareForClaudeLaunch()

    for (const name of ['CLAUDE.md', 'settings.json', 'plugins', 'projects']) {
      const target = join(managedAuthPath, name)
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
      expect(realpathSync(target)).toBe(realpathSync(join(expectedRuntimeConfigDir(), name)))
    }
    expect(lstatSync(join(managedAuthPath, '.credentials.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe(
      managedCredentials
    )
    expect(lstatSync(join(managedAuthPath, 'oauth-account.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(managedAuthPath, 'oauth-account.json'), 'utf-8')).toBe(
      managedOauthAccount
    )
  })
})
