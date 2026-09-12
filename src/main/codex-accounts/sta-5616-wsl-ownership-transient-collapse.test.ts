import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as WslPaths from '../../shared/wsl-paths'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STA-5616 regression: the WSL ownership probe collapsed every failure into a
// TRUST verdict, so a cold distro, a 5s timeout, or a 9p hiccup was
// indistinguishable from "this home is not Orca-owned". The host lane has had
// the owned/untrusted/indeterminate tri-state since STA-4422; only a
// *dispositive* untrusted verdict may clear durable state.

const rmSyncMock = vi.hoisted(() => vi.fn())

/** `rmSync` is mocked below, so fixture teardown needs the unmocked original. */
const realFs = vi.hoisted(() => ({ rmSync: null as typeof NodeFs.rmSync | null }))

/** Paths that fail every read with an injected errno, modelling a held 9p/AV lock. */
const fsFaults = vi.hoisted(() => {
  const held = new Map<string, string>()
  return {
    hold(path: string, code: string): void {
      held.set(path, code)
    },
    reset(): void {
      held.clear()
    },
    consume(target: unknown, syscall: string): void {
      const code = typeof target === 'string' ? held.get(target) : undefined
      if (!code) {
        return
      }
      const error: NodeJS.ErrnoException = new Error(`${code}: ${syscall} '${String(target)}'`)
      error.code = code
      error.syscall = syscall
      error.path = String(target)
      throw error
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  realFs.rmSync = actual.rmSync
  const patched = {
    ...actual,
    rmSync: rmSyncMock,
    statSync: (...args: unknown[]) => {
      fsFaults.consume(args[0], 'stat')
      return (actual.statSync as (...a: unknown[]) => unknown)(...args)
    },
    lstatSync: (...args: unknown[]) => {
      fsFaults.consume(args[0], 'lstat')
      return (actual.lstatSync as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-user-data' }
}))

/** Lets a real temp dir stand in for a drvfs/9p mount of a WSL managed home. */
const mountedPathAlias = vi.hoisted(() => ({ hostPath: '', linuxPath: '' }))

vi.mock('../../shared/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof WslPaths>()
  return {
    ...actual,
    parseWslUncPath: (path: string) =>
      path === mountedPathAlias.hostPath && path !== ''
        ? { distro: 'Ubuntu', linuxPath: mountedPathAlias.linuxPath }
        : actual.parseWslUncPath(path)
  }
})

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { CodexManagedHomeLifecycle } from './codex-managed-home-lifecycle'
import { CodexManagedHomePath } from './codex-managed-home-path'
import {
  ManagedCodexHomeTemporarilyUnavailableError,
  UntrustedManagedCodexHomeError
} from './host-codex-managed-home-ownership'

const DISTRO = 'Ubuntu'
const ACCOUNT_ID = 'account-1'
const LINUX_HOME = `/home/dev/.local/share/orca/codex-accounts/${ACCOUNT_ID}/home`
const UNC_HOME = `\\\\wsl.localhost\\${DISTRO}${LINUX_HOME.replace(/\//g, '\\')}`

/** The tagged line the guest prints for an Orca-owned home. */
function ownedVerdict(linuxPath = LINUX_HOME): string {
  return `ORCA_CODEX_HOME_VERDICT:owned:${Buffer.from(linuxPath, 'utf-8').toString('base64')}\n`
}

/** A `wsl.exe` run that never produced output: killed at the 5s timeout. */
function timeoutFailure(): Error {
  const error = new Error('spawnSync wsl.exe ETIMEDOUT') as NodeJS.ErrnoException & {
    signal?: string
    status?: number | null
  }
  error.code = 'ETIMEDOUT'
  error.signal = 'SIGTERM'
  error.status = null
  return error
}

let originalPlatform: PropertyDescriptor | undefined

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  setPlatform('win32')
  rmSyncMock.mockReset()
  runWslProcessMock.mockReset()
  fsFaults.reset()
  mountedPathAlias.hostPath = ''
  mountedPathAlias.linuxPath = ''
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

describe('WSL Codex ownership probe classification', () => {
  it('reports a probe timeout as indeterminate, not as an untrusted home', () => {
    const paths = new CodexManagedHomePath(() => {
      throw timeoutFailure()
    })

    let thrown: unknown
    try {
      paths.assert(UNC_HOME, ACCOUNT_ID)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
    expect(thrown).not.toBeInstanceOf(UntrustedManagedCodexHomeError)
  })

  it('reports a probe that emits no verdict as indeterminate', () => {
    const paths = new CodexManagedHomePath(() => '')

    expect(() => paths.assert(UNC_HOME, ACCOUNT_ID)).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })

  it('still reports a marker owned by another account as a dispositive untrusted verdict', () => {
    const paths = new CodexManagedHomePath(() => 'ORCA_CODEX_HOME_VERDICT:marker-mismatch\n')

    let thrown: unknown
    try {
      paths.assert(UNC_HOME, ACCOUNT_ID)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(UntrustedManagedCodexHomeError)
    expect(thrown).not.toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('still reports a missing ownership marker as a dispositive untrusted verdict', () => {
    const paths = new CodexManagedHomePath(() => 'ORCA_CODEX_HOME_VERDICT:missing-marker\n')

    expect(() => paths.assert(UNC_HOME, ACCOUNT_ID)).toThrow(UntrustedManagedCodexHomeError)
  })

  it('resolves an owned home back to its Windows spelling', () => {
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    expect(paths.assert(UNC_HOME, ACCOUNT_ID)).toBe(UNC_HOME)
  })

  it('rejects a structurally foreign WSL path as untrusted without running a probe', () => {
    const probe = vi.fn(() => '')
    const paths = new CodexManagedHomePath(probe)

    expect(() =>
      paths.assert(`\\\\wsl.localhost\\${DISTRO}\\home\\dev\\.codex`, ACCOUNT_ID)
    ).toThrow(UntrustedManagedCodexHomeError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects a managed path spelled for another account as untrusted without a probe', () => {
    const probe = vi.fn(() => '')
    const paths = new CodexManagedHomePath(probe)
    const otherAccountHome = UNC_HOME.replace(ACCOUNT_ID, 'someone-else')

    expect(() => paths.assert(otherAccountHome, ACCOUNT_ID)).toThrow(UntrustedManagedCodexHomeError)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('WSL managed home cleanup after a fail-once probe', () => {
  it('does not delete a freshly authenticated WSL home when the probe failed transiently', () => {
    // Models the real add path: the ownership re-gate inside identity read hits a
    // transient fault, `add` rolls back, and the rollback's own re-gate succeeds
    // because the fault was transient. Before STA-5616 that deleted the home.
    let calls = 0
    const paths = new CodexManagedHomePath(() => {
      calls += 1
      if (calls === 1) {
        throw timeoutFailure()
      }
      return ownedVerdict()
    })
    const lifecycle = new CodexManagedHomeLifecycle(paths)

    let addFailure: unknown
    try {
      paths.assert(UNC_HOME, ACCOUNT_ID)
    } catch (error) {
      addFailure = error
    }
    lifecycle.removeUnlessUnproven(addFailure, UNC_HOME, ACCOUNT_ID)

    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('still deletes the home when the add failed for a proven reason', () => {
    // Control for the case above: same rollback, same healthy probe, but a
    // failure that is not an unproven observation. Cleanup must still run.
    const paths = new CodexManagedHomePath(() => ownedVerdict())
    const lifecycle = new CodexManagedHomeLifecycle(paths)

    lifecycle.removeUnlessUnproven(
      new Error('Codex login completed, but Orca could not resolve the account email.'),
      UNC_HOME,
      ACCOUNT_ID
    )

    expect(rmSyncMock).toHaveBeenCalled()
  })

  it('refuses to delete a home the probe proved belongs to another account', () => {
    const paths = new CodexManagedHomePath(() => 'ORCA_CODEX_HOME_VERDICT:marker-mismatch\n')
    const lifecycle = new CodexManagedHomeLifecycle(paths)

    let addFailure: unknown
    try {
      paths.assert(UNC_HOME, ACCOUNT_ID)
    } catch (error) {
      addFailure = error
    }
    lifecycle.removeUnlessUnproven(addFailure, UNC_HOME, ACCOUNT_ID)

    expect(addFailure).toBeInstanceOf(UntrustedManagedCodexHomeError)
    expect(rmSyncMock).not.toHaveBeenCalled()
  })
})

describe('WSL managed home preparation for re-authentication', () => {
  const account = {
    id: ACCOUNT_ID,
    email: 'dev@example.com',
    managedHomePath: UNC_HOME,
    managedHomeRuntime: 'wsl' as const,
    wslDistro: DISTRO,
    wslLinuxHomePath: LINUX_HOME,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }

  // A kill at the deadline can still report a zero status, so `timedOut` has to
  // be read on its own rather than inferred from the exit code.
  it.each([null, 0])(
    'reports a preparation timed out at exit %s as indeterminate',
    async (code) => {
      runWslProcessMock.mockResolvedValue({
        code,
        stdout: '',
        stderr: '',
        timedOut: true,
        environmentResolved: true
      })
      const paths = new CodexManagedHomePath(() => ownedVerdict())

      await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
        ManagedCodexHomeTemporarilyUnavailableError
      )
    }
  )

  it('reports a foreign directory found during preparation as untrusted', async () => {
    runWslProcessMock.mockResolvedValue({
      code: 41,
      stdout: '',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    })
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
      UntrustedManagedCodexHomeError
    )
  })

  it('reports an unexplained preparation exit as indeterminate', async () => {
    runWslProcessMock.mockResolvedValue({
      code: 127,
      stdout: '',
      stderr: 'bash: not found',
      timedOut: false,
      environmentResolved: true
    })
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })
})

describe('mounted WSL Codex home reached through the filesystem, not wsl.exe', () => {
  let mountRoot: string
  let mountedHome: string

  beforeEach(() => {
    setPlatform('linux')
    mountRoot = mkdtempSync(join(tmpdir(), 'orca-sta-5616-'))
    mountedHome = join(mountRoot, 'home')
    mkdirSync(mountedHome, { recursive: true })
    writeFileSync(join(mountedHome, '.orca-managed-home'), `${ACCOUNT_ID}\n`, 'utf-8')
    mountedPathAlias.hostPath = mountedHome
    mountedPathAlias.linuxPath = LINUX_HOME
  })

  afterEach(() => {
    realFs.rmSync!(mountRoot, { recursive: true, force: true })
  })

  function assertMounted(): string {
    return new CodexManagedHomePath(() => '').assert(mountedHome, ACCOUNT_ID)
  }

  it('accepts a marked home under the managed root', () => {
    expect(assertMounted()).toBe(mountedHome)
  })

  it('reports a home the filesystem refuses to stat as indeterminate', () => {
    fsFaults.hold(mountedHome, 'EPERM')

    expect(assertMounted).toThrow(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('reports an unreadable ownership marker as indeterminate, not as a missing one', () => {
    fsFaults.hold(join(mountedHome, '.orca-managed-home'), 'EBUSY')

    expect(assertMounted).toThrow(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('still reports a definitively absent marker as untrusted', () => {
    realFs.rmSync!(join(mountedHome, '.orca-managed-home'))

    expect(assertMounted).toThrow(UntrustedManagedCodexHomeError)
  })

  it('still reports a definitively absent home as untrusted', () => {
    realFs.rmSync!(mountedHome, { recursive: true })

    expect(assertMounted).toThrow(UntrustedManagedCodexHomeError)
  })

  it('still reports a marker owned by another account as untrusted', () => {
    writeFileSync(join(mountedHome, '.orca-managed-home'), 'someone-else\n', 'utf-8')

    expect(assertMounted).toThrow(UntrustedManagedCodexHomeError)
  })
})
