import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { EventEmitter } from 'node:events'
import type * as NodeFs from 'node:fs'
import type * as HostCodexManagedHomeOwnership from './host-codex-managed-home-ownership'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import {
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const authFaults = vi.hoisted(() => {
  const state = {
    denied: new Set<string>(),
    deny(path: string): void {
      state.denied.add(path)
    },
    reset(): void {
      state.denied.clear()
    },
    isDenied(target: unknown): boolean {
      return typeof target === 'string' && state.denied.has(target)
    },
    throwDenial(target: string, syscall: string): never {
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, ${syscall} '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

// Fault reads and existence checks together so alternate probes cannot hide the denial.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const originalRead = actual.readFileSync as (...args: unknown[]) => unknown
  const originalExists = actual.existsSync as (...args: unknown[]) => boolean
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: Object.assign((...args: unknown[]): unknown => {
      if (authFaults.isDenied(args[0])) {
        authFaults.throwDenial(args[0] as string, 'read')
      }
      return originalRead(...args)
    }, originalRead),
    existsSync: Object.assign((...args: unknown[]): boolean => {
      // Model existsSync reporting false on denied paths as well as missing ones.
      return authFaults.isDenied(args[0]) ? false : originalExists(...args)
    }, originalExists)
  }
  return { ...patched, default: patched }
})

const {
  existsSync: realExistsSync,
  readdirSync: realReaddirSync,
  readFileSync: realReadFileSync,
  writeFileSync: realWriteFileSync
} = await vi.importActual<typeof NodeFs>('node:fs')

// Import after resetModules so instanceof uses the service's error constructor.
async function importTemporarilyUnavailableError(): Promise<
  typeof HostCodexManagedHomeOwnership.ManagedCodexHomeTemporarilyUnavailableError
> {
  return (await import('./host-codex-managed-home-ownership'))
    .ManagedCodexHomeTemporarilyUnavailableError
}

function makeLoginChild(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: () => void
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: () => void
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  return child
}

function authJsonFor(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } })
}

/** Include account home paths even if their home leaf has been removed. */
function listManagedHomes(): string[] {
  const root = join(testState.userDataDir, 'codex-accounts')
  if (!realExistsSync(root)) {
    return []
  }
  return realReaddirSync(root).map((accountId) => join(root, accountId, 'home'))
}

describe('STA-4734 a locked auth.json must not delete a just-authenticated home', () => {
  registerCodexAccountsTestHomes()

  it('keeps the managed home and its credentials when the identity read is denied', async () => {
    vi.resetModules()
    authFaults.reset()

    let deniedAuthPath = ''
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = makeLoginChild()
        const loginHome = options.env.CODEX_HOME!

        deniedAuthPath = join(loginHome, 'auth.json')
        realWriteFileSync(deniedAuthPath, authJsonFor('user@example.com'), 'utf-8')

        authFaults.deny(deniedAuthPath)
        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const store = createStore(createSettings())
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.addAccount()).rejects.toBeInstanceOf(
        await importTemporarilyUnavailableError()
      )

      expect(deniedAuthPath).not.toBe('')
      const survivors = listManagedHomes().filter((home) => realExistsSync(home))
      expect(survivors).toHaveLength(1)
      expect(realExistsSync(deniedAuthPath)).toBe(true)
      expect(realReadFileSync(deniedAuthPath, 'utf-8')).toBe(authJsonFor('user@example.com'))
    } finally {
      authFaults.reset()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('still deletes the managed home when the login genuinely fails', async () => {
    vi.resetModules()
    authFaults.reset()

    const spawnMock = vi.fn(() => {
      const child = makeLoginChild()
      queueMicrotask(() => child.emit('close', 1))
      return child
    })
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.addAccount()).rejects.toThrow(/Codex login exited with code 1/)
      expect(listManagedHomes().filter((home) => realExistsSync(home))).toHaveLength(0)
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('treats a denied auth.json after a Windows tree kill as the success it is', async () => {
    vi.resetModules()
    authFaults.reset()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const child = makeLoginChild() as ReturnType<typeof makeLoginChild> & {
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.pid = 5150
    child.exitCode = null
    child.signalCode = null
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn(() => child) }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      const loginPromise = (
        service as unknown as { runCodexLogin(managedHomePath: string): Promise<void> }
      ).runCodexLogin(testState.fakeHomeDir)

      const authPath = join(testState.fakeHomeDir, 'auth.json')
      realWriteFileSync(authPath, authJsonFor('user@example.com'), 'utf-8')

      await vi.advanceTimersByTimeAsync(6_000)

      // Deny the file after the watcher arms the kill to exercise the close-handler recheck.
      authFaults.deny(authPath)
      child.emit('close', 1)

      await expect(loginPromise).resolves.toBeUndefined()
    } finally {
      authFaults.reset()
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('still fails a Windows tree kill whose auth.json is definitively gone', async () => {
    vi.resetModules()
    authFaults.reset()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const child = makeLoginChild() as ReturnType<typeof makeLoginChild> & {
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.pid = 5151
    child.exitCode = null
    child.signalCode = null
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn(() => child) }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      const loginPromise = (
        service as unknown as { runCodexLogin(managedHomePath: string): Promise<void> }
      ).runCodexLogin(testState.fakeHomeDir)

      await vi.advanceTimersByTimeAsync(6_000)
      child.emit('close', 1)

      await expect(loginPromise).rejects.toThrow(/Codex login exited with code 1/)
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('does not advise "run codex login" for a source home it merely could not read', async () => {
    vi.resetModules()
    authFaults.reset()

    const sourceHome = join(testState.fakeHomeDir, '.codex')
    const sourceAuthPath = join(sourceHome, 'auth.json')
    realWriteFileSync(sourceAuthPath, authJsonFor('imported@example.com'), 'utf-8')
    authFaults.deny(sourceAuthPath)

    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn() }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      const rejection = service.addAccountFromHome(sourceHome)
      await expect(rejection).rejects.toBeInstanceOf(await importTemporarilyUnavailableError())
      await expect(rejection).rejects.not.toThrow(/Run `codex login`/)
    } finally {
      authFaults.reset()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('still reports a genuinely empty source home as having no credentials', async () => {
    vi.resetModules()
    authFaults.reset()

    const sourceHome = join(testState.fakeHomeDir, 'empty-codex-home')
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn() }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.addAccountFromHome(sourceHome)).rejects.toThrow(
        /No Codex credentials found/
      )
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })
})
