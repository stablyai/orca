import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restorePlatform, setPlatform } from './claude-account-service-test-harness'
import type * as WslPathsModule from '../../shared/wsl-paths'
import type * as WslModule from '../wsl'
import type * as ManagedAuthPathModule from './managed-auth-path'
import type * as NodeFsModule from 'node:fs'

// STA-5674 regression. A fail-once ownership probe during managed-account add
// makes `writeOauthAccount` throw AFTER `writeCredentials` has already written
// `.credentials.json`; cleanup used to re-gate successfully and rmSync the whole
// account directory. Injecting at `writeCredentials` proves nothing — that gate
// runs before any bytes exist.

// Hoisted holder, not a hoisted mkdtemp: vi.hoisted() runs before the static
// imports it would need.
const paths = vi.hoisted(() => ({ userDataRoot: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userDataRoot }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

// The two path-spelling shims below are the ONLY concession to running the
// win32 lane on a POSIX host: they make the distro's guest paths addressable by
// real `node:fs` so the credential bytes under test are real bytes.
vi.mock('../../shared/wsl-paths', async (importOriginal) => {
  const original = await importOriginal<typeof WslPathsModule>()
  return {
    ...original,
    parseWslUncPath: (path: string) =>
      path.includes('/.local/share/orca/claude-accounts/')
        ? { distro: 'Ubuntu', linuxPath: path }
        : original.parseWslUncPath(path)
  }
})

vi.mock('../wsl', async (importOriginal) => {
  const original = await importOriginal<typeof WslModule>()
  return { ...original, toWindowsWslPath: (linuxPath: string) => linuxPath }
})

const wslMocks = vi.hoisted(() => ({ runWslProcess: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: wslMocks.runWslProcess,
  DEFAULT_WSL_TIMEOUT_MS: 30_000
}))

// The host-lane fault is injected at the filesystem, not at the ownership
// function's return value: a transient lock is an errno, and it is the
// classifier under test that has to decide what an EBUSY means. A mock that
// hands back a pre-decided `null` would be asserting the answer.
const fsFaults = vi.hoisted(() => ({
  realpathLocked: false,
  realpathHits: 0,
  rmLocked: false,
  rmHits: 0
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsModule>()
  const realpathSync = ((path: Parameters<typeof original.realpathSync>[0], options?: never) => {
    if (fsFaults.realpathLocked) {
      fsFaults.realpathHits += 1
      const error = new Error(
        `EBUSY: resource busy or locked, realpath '${String(path)}'`
      ) as NodeJS.ErrnoException
      error.code = 'EBUSY'
      error.errno = -16
      error.syscall = 'realpath'
      throw error
    }
    return original.realpathSync(path, options)
  }) as typeof original.realpathSync
  realpathSync.native = original.realpathSync.native
  const rmSync = ((path: never, options: never) => {
    if (fsFaults.rmLocked) {
      fsFaults.rmHits += 1
      const error = new Error(
        `EBUSY: resource busy or locked, rm '${String(path)}'`
      ) as NodeJS.ErrnoException
      error.code = 'EBUSY'
      throw error
    }
    return original.rmSync(path, options)
  }) as typeof original.rmSync
  const mocked = { ...original, realpathSync, rmSync }
  return { ...mocked, default: mocked }
})

const authPathMocks = vi.hoisted(() => ({
  failOwnershipOnCall: 0,
  ownershipCalls: 0,
  faultsFired: 0,
  credentialsAtFault: null as string | null
}))

vi.mock('./managed-auth-path', async (importOriginal) => {
  const original = await importOriginal<typeof ManagedAuthPathModule>()
  const withFaultOnNthCall = <T>(candidatePath: string, run: () => T): T => {
    authPathMocks.ownershipCalls += 1
    if (authPathMocks.ownershipCalls !== authPathMocks.failOwnershipOnCall) {
      return run()
    }
    authPathMocks.faultsFired += 1
    authPathMocks.credentialsAtFault = readIfPresent(`${candidatePath}/.credentials.json`)
    fsFaults.realpathLocked = true
    try {
      return run()
    } finally {
      fsFaults.realpathLocked = false
    }
  }
  return {
    ...original,
    resolveClaudeManagedAuthVerdict: (
      accountId: string,
      candidatePath: string,
      options?: { adoptLegacyMarker?: boolean }
    ) =>
      withFaultOnNthCall(candidatePath, () =>
        original.resolveClaudeManagedAuthVerdict(accountId, candidatePath, options)
      ),
    resolveOwnedClaudeManagedAuthPath: (
      accountId: string,
      candidatePath: string,
      options?: { adoptLegacyMarker?: boolean }
    ) =>
      withFaultOnNthCall(candidatePath, () =>
        original.resolveOwnedClaudeManagedAuthPath(accountId, candidatePath, options)
      )
  }
})

// Read through a plain require-free helper so the mock factory stays hoistable.
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"sta5674-real-token"}}\n'
const VERDICT_TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'

function wslOk(stdout: string) {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

function wslTimeout() {
  return { environmentResolved: true, code: null, stdout: '', stderr: '', timedOut: true }
}

/** What the guest script prints when it finds a valid marker under the root. */
function wslOwnedVerdict(candidate: string) {
  return wslOk(`${VERDICT_TAG}owned:${Buffer.from(candidate, 'utf-8').toString('base64')}\n`)
}

type ServiceHarness = {
  service: {
    addAccount: (target?: { runtime?: 'host' | 'wsl'; wslDistro?: string }) => Promise<unknown>
    removeAccount: (accountId: string) => Promise<unknown>
  }
  settings: () => { claudeManagedAccounts: unknown[] }
  // Resolved from the same registry the service was built from: `vi.resetModules()`
  // means a top-level import is a different class object than the one thrown.
  temporarilyUnavailable: new (...args: never[]) => Error
  keychainDelete: ReturnType<typeof vi.fn>
  failLoginWith: (error: Error) => void
}

async function buildService(
  options: { throwOnUpdateSettingsCall?: number } = {}
): Promise<ServiceHarness> {
  let updateSettingsCalls = 0
  let settings = {
    claudeManagedAccounts: [] as unknown[],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
  }
  const store = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<typeof settings>) => {
      updateSettingsCalls += 1
      if (updateSettingsCalls === options.throwOnUpdateSettingsCall) {
        throw new Error('settings write failed during cleanup')
      }
      settings = { ...settings, ...updates }
      return settings
    })
  }
  const runtimeAuth = {
    clearLastWrittenCredentialsJson: vi.fn(),
    syncForCurrentSelection: vi.fn(async () => {}),
    forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
    getRuntimeConfigDir: vi.fn(() => paths.userDataRoot)
  }
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
  }
  const { ClaudeAccountService } = await import('./service')
  const service = new ClaudeAccountService(
    store as never,
    rateLimits as never,
    runtimeAuth as never
  )
  ;(
    service as unknown as { runClaudeLoginAndCapture: () => Promise<unknown> }
  ).runClaudeLoginAndCapture = vi.fn(async () => ({
    credentialsJson: CREDENTIALS,
    oauthAccount: { accountUuid: 'sta5674' },
    identity: { email: 'sta5674@example.com', organizationUuid: null, organizationName: null }
  }))
  const login = service as unknown as { runClaudeLoginAndCapture: () => Promise<unknown> }
  const ownership = await import('./claude-managed-auth-ownership')
  const keychain = await import('./keychain')
  // The factory is cached across `vi.resetModules()`, so call counts would
  // otherwise accumulate across tests and make a `not.toHaveBeenCalled` pass or
  // fail on test order rather than on behaviour.
  vi.mocked(keychain.deleteManagedClaudeKeychainCredentials).mockClear()
  return {
    service: service as unknown as ServiceHarness['service'],
    settings: () => settings,
    temporarilyUnavailable: ownership.ManagedClaudeAuthTemporarilyUnavailableError,
    keychainDelete: vi.mocked(keychain.deleteManagedClaudeKeychainCredentials),
    failLoginWith: (error: Error) => {
      login.runClaudeLoginAndCapture = vi.fn(async () => {
        throw error
      })
    }
  }
}

describe('STA-5674: fail-once ownership probe during Claude managed-account add', () => {
  let guestHome: string | null = null
  const extraTempDirs: string[] = []

  beforeEach(() => {
    vi.resetModules()
    wslMocks.runWslProcess.mockReset()
    authPathMocks.failOwnershipOnCall = 0
    authPathMocks.ownershipCalls = 0
    authPathMocks.faultsFired = 0
    authPathMocks.credentialsAtFault = null
    fsFaults.realpathLocked = false
    fsFaults.realpathHits = 0
    fsFaults.rmLocked = false
    fsFaults.rmHits = 0
    extraTempDirs.length = 0
    guestHome = mkdtempSync(join(tmpdir(), 'sta5674-guest-'))
    paths.userDataRoot = mkdtempSync(join(tmpdir(), 'sta5674-userdata-'))
  })

  afterEach(() => {
    restorePlatform()
    fsFaults.realpathLocked = false
    fsFaults.rmLocked = false
    for (const dir of extraTempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (guestHome) {
      rmSync(guestHome, { recursive: true, force: true })
    }
    if (paths.userDataRoot) {
      rmSync(paths.userDataRoot, { recursive: true, force: true })
    }
  })

  it('win32/WSL lane: a one-shot probe timeout at writeOauthAccount keeps the account directory and the credentials just written', async () => {
    setPlatform('win32')
    const home = guestHome!
    let ownershipProbes = 0
    const observed: { credentialsAtFault: string | null; accountDir: string | null } = {
      credentialsAtFault: null,
      accountDir: null
    }

    // A fake WSL guest that executes each script's intent against the real
    // temp filesystem, so ownership is decided by real files.
    wslMocks.runWslProcess.mockImplementation(async (spec: { script: string; args?: string[] }) => {
      if (spec.script.includes('WSL_DISTRO_NAME')) {
        return wslOk(`Ubuntu\n${home}\n`)
      }
      if (spec.script.includes('mkdir -p')) {
        const [dir, accountId] = spec.args ?? []
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, '.orca-managed-claude-auth'), `${accountId}\n`, { mode: 0o600 })
        return wslOk('')
      }
      // Ownership probe. Probe order: 1 = create(), 2 = writeCredentials,
      // 3 = writeOauthAccount (the fault).
      ownershipProbes += 1
      const candidate = spec.script.match(/candidate='([^']+)'/)?.[1] ?? ''
      if (ownershipProbes === 3) {
        const credentialsPath = join(candidate, '.credentials.json')
        observed.credentialsAtFault = existsSync(credentialsPath)
          ? readFileSync(credentialsPath, 'utf-8')
          : null
        observed.accountDir = join(candidate, '..')
        return wslTimeout()
      }
      const marker = join(candidate, '.orca-managed-claude-auth')
      return existsSync(marker)
        ? wslOwnedVerdict(candidate)
        : wslOk(`${VERDICT_TAG}missing-marker\n`)
    })

    const { service, settings, temporarilyUnavailable, keychainDelete } = await buildService()
    const failure = await service
      .addAccount({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      .then(() => null)
      .catch((error: unknown) => error)

    // A probe that never completed is reported as such, not as a trust verdict.
    expect(failure).toBeInstanceOf(temporarilyUnavailable)
    expect((failure as Error).message).toMatch(/temporarily locked/)

    // The fault landed after real credential bytes existed.
    expect(observed.credentialsAtFault).toBe(CREDENTIALS)

    const accountDir = observed.accountDir!
    expect(existsSync(accountDir)).toBe(true)
    const credentialsPath = join(accountDir, 'auth', '.credentials.json')
    expect(existsSync(credentialsPath)).toBe(true)
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(CREDENTIALS)
    // 3 probes, not 4: cleanup must not re-gate the path at all. The re-gate is
    // what used to succeed and authorise the delete.
    expect(ownershipProbes).toBe(3)
    // Leaked, not registered: the add still fails and nothing durable moves.
    expect(settings().claudeManagedAccounts).toHaveLength(0)
    expect(keychainDelete).not.toHaveBeenCalled()
  })

  it('host lane (no path shims): a one-shot ownership fault at writeOauthAccount keeps the account directory and the credentials just written', async () => {
    setPlatform('linux')
    // create() probe = 1, writeCredentials = 2, writeOauthAccount = 3.
    authPathMocks.failOwnershipOnCall = 3

    const { service, settings, temporarilyUnavailable, keychainDelete } = await buildService()
    const failure = await service
      .addAccount({ runtime: 'host' })
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(temporarilyUnavailable)
    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    // The fault landed after real credential bytes existed.
    expect(authPathMocks.faultsFired).toBe(1)
    expect(authPathMocks.credentialsAtFault).toBe(CREDENTIALS)
    const accountId = (settings().claudeManagedAccounts[0] as { id?: string } | undefined)?.id
    expect(accountId).toBeUndefined()
    // Three probes, not four: cleanup must not re-gate the path at all.
    expect(authPathMocks.ownershipCalls).toBe(3)
    const { readdirSync } = await import('node:fs')
    const leaked = readdirSync(accountsRoot)
    expect(leaked).toHaveLength(1)
    const credentialsPath = join(accountsRoot, leaked[0], 'auth', '.credentials.json')
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(CREDENTIALS)
    expect(keychainDelete).not.toHaveBeenCalled()
  })

  it('CONTROL — no fault: the account directory and its credentials survive the same add', async () => {
    setPlatform('linux')
    authPathMocks.failOwnershipOnCall = 0

    const { service, settings } = await buildService()
    await service.addAccount({ runtime: 'host' })

    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    const accountId = (settings().claudeManagedAccounts[0] as { id: string }).id
    const credentialsPath = join(accountsRoot, accountId, 'auth', '.credentials.json')
    expect(existsSync(credentialsPath)).toBe(true)
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(CREDENTIALS)
  })

  it('CONTROL — injecting at writeCredentials proves nothing: no credential bytes exist when that gate fails', async () => {
    setPlatform('linux')
    // create() probe = 1, writeCredentials = 2. Its gate runs BEFORE any write.
    authPathMocks.failOwnershipOnCall = 2

    const { service } = await buildService()
    await expect(service.addAccount({ runtime: 'host' })).rejects.toThrow(/temporarily locked/)

    // `credentialsAtFault` is null both when the gate saw no credentials and
    // when the fault never fired, so assert the fault first.
    expect(authPathMocks.faultsFired).toBe(1)
    expect(authPathMocks.credentialsAtFault).toBeNull()
    const { readdirSync } = await import('node:fs')
    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    const leaked = readdirSync(accountsRoot)
    expect(leaked).toHaveLength(1)
    expect(existsSync(join(accountsRoot, leaked[0], 'auth', '.credentials.json'))).toBe(false)
  })

  it("a user-requested removal does not delete a path that is not this account's own storage", async () => {
    setPlatform('linux')
    const { service, settings, keychainDelete } = await buildService()
    await service.addAccount({ runtime: 'host' })
    const account = settings().claudeManagedAccounts[0] as { id: string; managedAuthPath: string }
    // Settings tampering, or a stale record: the persisted path is not the one
    // Orca would have chosen for this account.
    const foreign = mkdtempSync(join(tmpdir(), 'sta5674-foreign-'))
    writeFileSync(join(foreign, 'precious.txt'), 'not ours to delete')
    account.managedAuthPath = join(foreign, 'auth')

    await service.removeAccount(account.id)

    expect(existsSync(join(foreign, 'precious.txt'))).toBe(true)
    expect(settings().claudeManagedAccounts).toHaveLength(0)
    expect(keychainDelete).toHaveBeenCalledWith(account.id)
    rmSync(foreign, { recursive: true, force: true })
  })

  it('cleanup after a non-ownership add failure still refuses to delete on an unprovable gate', async () => {
    setPlatform('linux')
    // The add fails at login, so the failure carries no ownership verdict and
    // cleanup's error check cannot short-circuit. The removal gate is then the
    // only thing standing between a transient fault and a deleted directory.
    const { service, failLoginWith } = await buildService()
    failLoginWith(new Error('Claude login was cancelled.'))
    // create() is probe 1; cleanup's own gate is probe 2.
    authPathMocks.failOwnershipOnCall = 2

    await expect(service.addAccount({ runtime: 'host' })).rejects.toThrow(/login was cancelled/)

    expect(authPathMocks.faultsFired).toBe(1)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(join(paths.userDataRoot, 'claude-accounts'))).toHaveLength(1)
  })

  it('reports the add failure, not the cleanup failure, when cleanup itself throws', async () => {
    setPlatform('linux')
    authPathMocks.failOwnershipOnCall = 0
    // restoreSettings() is cleanup's first settings write, and it is the only
    // one that runs before removeManagedAuth.
    const { service, failLoginWith } = await buildService({ throwOnUpdateSettingsCall: 1 })
    const loginFailure = new Error('Claude login was cancelled.')
    failLoginWith(loginFailure)

    await expect(service.addAccount({ runtime: 'host' })).rejects.toBe(loginFailure)
  })

  it('a user-requested removal deletes the account directory without consulting a probe that would fail', async () => {
    setPlatform('linux')
    const { service, settings, keychainDelete } = await buildService()
    await service.addAccount({ runtime: 'host' })
    const accountId = (settings().claudeManagedAccounts[0] as { id: string }).id
    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    // The add used probes 1-3. Arm the next one to fail: if removal consults an
    // ownership gate at all it gets an unprovable answer, and the assertion on
    // the call count below is what proves the fault was live rather than unused.
    authPathMocks.failOwnershipOnCall = 4

    await service.removeAccount(accountId)

    expect(authPathMocks.ownershipCalls).toBe(3)

    // The user asked for the account to be gone. Refusing to delete on an
    // unprovable probe leaves credentials on disk with no UI reference to them
    // — quietly kept is worse than visibly lost.
    expect(settings().claudeManagedAccounts).toHaveLength(0)
    expect(existsSync(join(accountsRoot, accountId, 'auth', '.credentials.json'))).toBe(false)
    expect(existsSync(join(accountsRoot, accountId))).toBe(false)
    expect(keychainDelete).toHaveBeenCalledWith(accountId)
  })

  it('a user-requested removal that cannot delete the files reports the failure and keeps the account', async () => {
    setPlatform('linux')
    const { service, settings, keychainDelete } = await buildService()
    await service.addAccount({ runtime: 'host' })
    const accountId = (settings().claudeManagedAccounts[0] as { id: string }).id
    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    fsFaults.rmLocked = true

    await expect(service.removeAccount(accountId)).rejects.toThrow(/EBUSY/)

    expect(fsFaults.rmHits).toBeGreaterThan(0)

    // Telling the user it is gone while the credentials are still on disk is the
    // same silent retention as refusing to delete; the account must come back so
    // they can retry.
    expect(existsSync(join(accountsRoot, accountId, 'auth', '.credentials.json'))).toBe(true)
    expect(settings().claudeManagedAccounts).toHaveLength(1)
    expect(keychainDelete).not.toHaveBeenCalled()
  })

  it('a user-requested removal that cannot resolve the accounts root refuses rather than reporting success', async () => {
    setPlatform('linux')
    // Build the two-spelling situation rather than inheriting it: userData is a
    // symlink, so the persisted path (canonical, from the ownership gate) cannot
    // equal the literal root and canonicalising the root is genuinely required.
    // Relying on the OS for this passed on macOS, where /var is a symlink, and
    // silently tested nothing on Linux CI, where it is not.
    const realRoot = mkdtempSync(join(tmpdir(), 'sta5674-realroot-'))
    const linkHome = mkdtempSync(join(tmpdir(), 'sta5674-linkhome-'))
    extraTempDirs.push(realRoot, linkHome)
    const linkedRoot = join(linkHome, 'userdata')
    symlinkSync(realRoot, linkedRoot, 'dir')
    paths.userDataRoot = linkedRoot

    const { service, settings, keychainDelete } = await buildService()
    await service.addAccount({ runtime: 'host' })
    const account = settings().claudeManagedAccounts[0] as { id: string; managedAuthPath: string }
    // Precondition, so this cannot silently decay back into a one-spelling test:
    // the persisted path is the canonical spelling and the literal root is not a
    // prefix of it.
    expect(account.managedAuthPath.startsWith(realpathSync(realRoot))).toBe(true)
    expect(account.managedAuthPath.startsWith(linkedRoot)).toBe(false)

    fsFaults.realpathLocked = true
    await expect(service.removeAccount(account.id)).rejects.toThrow(/could not locate/i)

    // The refusal came from the locked canonicalisation, not from never looking.
    expect(fsFaults.realpathHits).toBeGreaterThan(0)
    expect(
      existsSync(join(realRoot, 'claude-accounts', account.id, 'auth', '.credentials.json'))
    ).toBe(true)
    expect(settings().claudeManagedAccounts).toHaveLength(1)
    expect(keychainDelete).not.toHaveBeenCalled()
  })

  it('CONTROL — a user-requested removal still deletes the account directory and its keychain credentials', async () => {
    setPlatform('linux')
    authPathMocks.failOwnershipOnCall = 0

    const { service, settings, keychainDelete } = await buildService()
    await service.addAccount({ runtime: 'host' })
    const accountId = (settings().claudeManagedAccounts[0] as { id: string }).id
    const accountsRoot = join(paths.userDataRoot, 'claude-accounts')
    expect(existsSync(join(accountsRoot, accountId, 'auth', '.credentials.json'))).toBe(true)

    await service.removeAccount(accountId)

    expect(existsSync(join(accountsRoot, accountId))).toBe(false)
    expect(keychainDelete).toHaveBeenCalledWith(accountId)
    expect(settings().claudeManagedAccounts).toHaveLength(0)
  })
})
