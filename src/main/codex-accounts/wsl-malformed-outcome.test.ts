import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}))
/** A real writable userData root: the host lane mkdirs it before any gate runs. */
const userDataDir = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({ app: { getPath: () => userDataDir.path } }))

const mkdirFault = vi.hoisted(() => {
  let thrower: (() => never) | null = null
  return {
    set(next: () => never): void {
      thrower = next
    },
    reset(): void {
      thrower = null
    },
    consume(): void {
      if (thrower) {
        thrower()
      }
    }
  }
})

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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    statSync: (...args: unknown[]) => {
      statFaults.consume(args[0])
      return (actual.statSync as (...a: unknown[]) => unknown)(...args)
    },
    mkdirSync: (...args: unknown[]) => {
      mkdirFault.consume()
      return (actual.mkdirSync as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { ...patched, default: patched }
})

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { classifyWslCodexManagedHomeProbe } from './wsl-codex-managed-home-probe'
import { CodexManagedHomePath } from './codex-managed-home-path'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'

/**
 * R2 review: values crossing the runner boundary are not Orca's own. A malformed
 * or hostile shape must become `indeterminate`, never a raw throw that no caller
 * can recognise as an unproven observation.
 */
const DISTRO = 'Ubuntu'
const ACCOUNT_ID = 'account-1'
const LINUX_HOME = `/home/dev/.local/share/orca/codex-accounts/${ACCOUNT_ID}/home`
const UNC_HOME = `\\\\wsl.localhost\\${DISTRO}${LINUX_HOME.replace(/\//g, '\\')}`
const HOST_HOME_PATH = '/host/managed/home'

/** Built lazily: reading the field is the whole point, so it must not fire at collection. */
function withThrowingGetter(base: Record<string, unknown>, field: string): object {
  const target: Record<string, unknown> = { ...base }
  Object.defineProperty(target, field, {
    get(): never {
      throw new Error(`${field} accessor exploded`)
    },
    enumerable: true
  })
  return target
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({ ran: true, stdout: '' }, {})
  revoke()
  return proxy
}

let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  runWslProcessMock.mockReset()
  statFaults.reset()
  mkdirFault.reset()
  userDataDir.path = mkdtempSync(join(tmpdir(), 'orca-r2-userdata-'))
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

describe('probe outcomes that are not the shape the classifier expects', () => {
  const malformed: [string, () => unknown][] = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['a string', () => 'ORCA_CODEX_HOME_VERDICT:owned:x'],
    ['a number', () => 7],
    ['an empty object', () => ({})],
    ['ran:true with null stdout', () => ({ ran: true, stdout: null })],
    ['ran:true with a numeric stdout', () => ({ ran: true, stdout: 42 })],
    ['ran:true with no stdout at all', () => ({ ran: true })],
    ['a throwing `ran` getter', () => withThrowingGetter({}, 'ran')],
    ['a throwing `stdout` getter', () => withThrowingGetter({ ran: true }, 'stdout')],
    ['a revoked proxy', () => revokedProxy()]
  ]

  it.each(malformed)('classifies %s as indeterminate without throwing', (_label, build) => {
    let verdict: unknown
    expect(() => {
      verdict = classifyWslCodexManagedHomeProbe(build() as never, DISTRO)
    }).not.toThrow()
    expect((verdict as { kind: string }).kind).toBe('indeterminate')
  })

  it('still reads a well-formed outcome', () => {
    const encoded = Buffer.from(LINUX_HOME, 'utf-8').toString('base64')

    expect(
      classifyWslCodexManagedHomeProbe(
        { ran: true, stdout: `ORCA_CODEX_HOME_VERDICT:owned:${encoded}\n` },
        DISTRO
      ).kind
    ).toBe('owned')
  })
})

describe('preparation results that are not the shape the caller expects', () => {
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

  function ownedProbe(): string {
    return `ORCA_CODEX_HOME_VERDICT:owned:${Buffer.from(LINUX_HOME, 'utf-8').toString('base64')}\n`
  }

  const malformed: [string, () => unknown][] = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['a string', () => 'done'],
    ['an empty object', () => ({})],
    ['a non-boolean timedOut', () => ({ timedOut: 'no', code: 0 })],
    ['a non-numeric code', () => ({ timedOut: false, code: '0' })],
    ['a throwing `timedOut` getter', () => withThrowingGetter({}, 'timedOut')],
    ['a throwing `code` getter', () => withThrowingGetter({ timedOut: false }, 'code')]
  ]

  it.each(malformed)('reports %s as the typed indeterminate error', async (_label, build) => {
    runWslProcessMock.mockResolvedValue(build())
    const paths = new CodexManagedHomePath(() => ownedProbe())

    await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })

  it('still accepts a well-formed successful result', async () => {
    runWslProcessMock.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    })
    const paths = new CodexManagedHomePath(() => ownedProbe())

    await expect(paths.ensureForReauthentication(account)).resolves.toBe(UNC_HOME)
  })
})

describe('missing-home detection against a hostile failure', () => {
  const account = {
    id: ACCOUNT_ID,
    email: 'dev@example.com',
    managedHomePath: HOST_HOME_PATH,
    managedHomeRuntime: 'host' as const,
    wslDistro: null,
    wslLinuxHomePath: null,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }

  /**
   * Driven through the real filesystem seam rather than a spy on `assert`:
   * `vi.spyOn` records the thrown value and trips a revoked proxy's traps
   * itself, which would test the harness instead of the gate.
   */
  it('reports a hostile stat failure as the typed temporary error, not a raw throw', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    statFaults.hold(HOST_HOME_PATH, () => {
      const { proxy, revoke } = Proxy.revocable(new Error('gone'), {})
      revoke()
      throw proxy
    })
    const paths = new CodexManagedHomePath(() => {
      throw new Error('unused')
    })

    let thrown: unknown
    try {
      await paths.ensureForReauthentication(account)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
  })

  /**
   * `getRoot()` mkdirs before the gate builds any verdict, so a throw there is
   * the one failure that reaches the catch UNWRAPPED — which is exactly the
   * shape `isMissingHomeError` has to survive.
   */
  it.each([
    ['a throwing message accessor', () => withThrowingGetter({ code: 'EPERM' }, 'message')],
    [
      'a revoked proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable(new Error('gone'), {})
        revoke()
        return proxy
      }
    ],
    ['a bare string', () => 'the filesystem said no']
  ])('propagates %s from the gate without attempting recreation', async (_label, build) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const planted = build()
    mkdirFault.set((() => {
      throw planted
    }) as () => never)
    const paths = new CodexManagedHomePath(() => {
      throw new Error('unused')
    })

    let thrown: unknown
    let threwSomething = false
    try {
      await paths.ensureForReauthentication(account)
    } catch (error) {
      thrown = error
      threwSomething = true
    }

    // Identity, not `instanceof`: inspecting a revoked proxy throws, which is
    // precisely the failure mode this guards against.
    expect(threwSomething).toBe(true)
    expect(thrown === planted).toBe(true)
  })

  it('does not recreate the home when the failure message cannot be read', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    statFaults.hold(HOST_HOME_PATH, () => {
      throw withThrowingGetter({ code: 'EPERM' }, 'message')
    })
    const paths = new CodexManagedHomePath(() => {
      throw new Error('unused')
    })

    await expect(paths.ensureForReauthentication(account)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
  })
})
