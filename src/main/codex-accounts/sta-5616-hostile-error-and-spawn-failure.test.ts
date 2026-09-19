import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as WslPaths from '../../shared/wsl-paths'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PR #18001 review follow-ups: two ways a failure escaped the tri-state.
//   1. `isDefinitiveAbsence` read `.code` off an arbitrary thrown value, so an
//      error-like object with a throwing accessor escaped the fail-closed catch.
//   2. `runWslProcess` REJECTING (wsl.exe missing/unlaunchable) was never caught,
//      so the canonical "could not check" reached callers untyped.

const statFaults = vi.hoisted(() => {
  const held = new Map<string, () => never>()
  return {
    hold(path: string, thrower: () => never): void {
      held.set(path, thrower)
    },
    reset(): void {
      held.clear()
    },
    consume(target: unknown): void {
      const thrower = typeof target === 'string' ? held.get(target) : undefined
      if (thrower) {
        thrower()
      }
    }
  }
})

const realFs = vi.hoisted(() => ({ rmSync: null as typeof NodeFs.rmSync | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  realFs.rmSync = actual.rmSync
  const patched = {
    ...actual,
    statSync: (...args: unknown[]) => {
      statFaults.consume(args[0])
      return (actual.statSync as (...a: unknown[]) => unknown)(...args)
    },
    lstatSync: (...args: unknown[]) => {
      statFaults.consume(args[0])
      return (actual.lstatSync as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({ app: { getPath: () => '/unused-user-data' } }))

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

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

import { CodexManagedHomePath } from './codex-managed-home-path'
import {
  MARKER_NOT_REGULAR_FILE_MESSAGE,
  ManagedCodexHomeTemporarilyUnavailableError,
  UntrustedManagedCodexHomeError
} from './host-codex-managed-home-ownership'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

const ACCOUNT_ID = 'account-1'
const LINUX_HOME = `/home/dev/.local/share/orca/codex-accounts/${ACCOUNT_ID}/home`

let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  statFaults.reset()
  runWslProcessMock.mockReset()
  mountedPathAlias.hostPath = ''
  mountedPathAlias.linuxPath = ''
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

describe('isDefinitiveAbsence on values it did not create', () => {
  it('does not let a throwing errno accessor escape', () => {
    const hostile = {
      get code(): string {
        throw new Error('accessor exploded')
      }
    }

    expect(() => isDefinitiveAbsence(hostile)).not.toThrow()
    expect(isDefinitiveAbsence(hostile)).toBe(false)
  })

  it('does not treat a non-string errno as absence', () => {
    expect(isDefinitiveAbsence({ code: ['ENOENT'] })).toBe(false)
    expect(isDefinitiveAbsence({ code: 2 })).toBe(false)
  })

  it.each([undefined, null, 'ENOENT', 42, Symbol('ENOENT')])(
    'survives a thrown %s without throwing',
    (thrown) => {
      expect(() => isDefinitiveAbsence(thrown)).not.toThrow()
      expect(isDefinitiveAbsence(thrown)).toBe(false)
    }
  )

  it('still recognises the real absence codes', () => {
    expect(isDefinitiveAbsence(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isDefinitiveAbsence(Object.assign(new Error('x'), { code: 'ENOTDIR' }))).toBe(true)
    expect(isDefinitiveAbsence(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false)
  })
})

describe('mounted WSL gate against a hostile thrown value', () => {
  let mountRoot: string
  let mountedHome: string

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mountRoot = mkdtempSync(join(tmpdir(), 'orca-18001-'))
    mountedHome = join(mountRoot, 'home')
    mkdirSync(mountedHome, { recursive: true })
    writeFileSync(join(mountedHome, '.orca-managed-home'), `${ACCOUNT_ID}\n`, 'utf-8')
    mountedPathAlias.hostPath = mountedHome
    mountedPathAlias.linuxPath = LINUX_HOME
  })

  afterEach(() => {
    realFs.rmSync?.(mountRoot, { recursive: true, force: true })
  })

  it('classifies a stat failure whose errno accessor throws as indeterminate', () => {
    statFaults.hold(mountedHome, () => {
      throw {
        get code(): string {
          throw new Error('accessor exploded')
        }
      }
    })

    expect(() => new CodexManagedHomePath(() => '').assert(mountedHome, ACCOUNT_ID)).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })

  it('classifies a thrown non-object as indeterminate', () => {
    statFaults.hold(join(mountedHome, '.orca-managed-home'), () => {
      throw 'the filesystem said no'
    })

    expect(() => new CodexManagedHomePath(() => '').assert(mountedHome, ACCOUNT_ID)).toThrow(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })
})

describe('re-authentication preparation when wsl.exe cannot be launched', () => {
  const account = {
    id: ACCOUNT_ID,
    email: 'dev@example.com',
    managedHomePath: `\\\\wsl.localhost\\Ubuntu${LINUX_HOME.replace(/\//g, '\\')}`,
    managedHomeRuntime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    wslLinuxHomePath: LINUX_HOME,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }

  function ownedVerdict(): string {
    return `ORCA_CODEX_HOME_VERDICT:owned:${Buffer.from(LINUX_HOME, 'utf-8').toString('base64')}\n`
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  it('classifies a spawn rejection as indeterminate', async () => {
    const spawnFailure: NodeJS.ErrnoException = new Error('spawn wsl.exe ENOENT')
    spawnFailure.code = 'ENOENT'
    runWslProcessMock.mockRejectedValue(spawnFailure)
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    let thrown: unknown
    try {
      await paths.ensureForReauthentication(account)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
    expect((thrown as Error).cause).toBe(spawnFailure)
  })

  it('classifies a non-Error rejection from a wrapper as indeterminate', async () => {
    runWslProcessMock.mockRejectedValue('wsl.exe is not on PATH')
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })

  it('refuses when preparation finds a symlink in the marker position', async () => {
    // Exit 43: the guest must not `printf >` through a symlink, which would
    // write the account id into whatever the link points at.
    runWslProcessMock.mockResolvedValue({
      code: 43,
      stdout: '',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    })
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    let thrown: unknown
    try {
      await paths.ensureForReauthentication(account)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(UntrustedManagedCodexHomeError)
    expect((thrown as Error).message).toBe(MARKER_NOT_REGULAR_FILE_MESSAGE)
  })

  it('still resolves when preparation succeeds', async () => {
    runWslProcessMock.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    })
    const paths = new CodexManagedHomePath(() => ownedVerdict())

    await expect(paths.ensureForReauthentication(account)).resolves.toBe(account.managedHomePath)
  })
})
