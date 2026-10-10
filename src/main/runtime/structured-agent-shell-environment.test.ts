import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as loginShell from '../startup/login-shell-environment'
import type * as runProcessModule from '@orca/process-host'
import { __resetPersistedWindowsPathCacheForTests } from '../pty/windows-environment-path'
import { __setWindowsPathRegistryLoaderForTests } from '../pty/windows-path-registry-reader'
import {
  createStructuredAgentEnvironmentResolvers,
  structuredAgentBaseEnvironment
} from './structured-agent-shell-environment'

const { runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => {
  const real = await importOriginal<typeof runProcessModule>()
  return {
    ...real,
    runProcess: runProcessMock,
    // Unmocked calls spawn for real, so a stub login shell runs through the production capture.
    spawnProcess: (...args: Parameters<typeof real.spawnProcess>) =>
      spawnProcessMock(...args) ?? real.spawnProcess(...args)
  }
})

const INHERIT_ALL = { inheritAll: true, names: [] }

/** The value if the promise settles without any timer firing; undefined if it is still waiting. */
async function settledWithoutWaiting<T>(promise: Promise<T>): Promise<T | undefined> {
  let value: T | undefined
  void promise.then((resolved) => {
    value = resolved
  })
  await vi.advanceTimersByTimeAsync(0)
  return value
}

function pathSegments(env: Record<string, string>): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
  return key ? (env[key]?.split(';') ?? []) : []
}

/** A powershell.exe child that prints the env it was given plus one profile-only variable. */
function fakePowerShell(spec: { env: NodeJS.ProcessEnv }): EventEmitter {
  const stdout = new EventEmitter()
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: () => {} }),
    stdout,
    stderr: Object.assign(new EventEmitter(), { resume: () => {} }),
    kill: () => true
  })
  const printed = JSON.stringify({ ...spec.env, PROFILE_ONLY: '1' })
  setImmediate(() => {
    stdout.emit(
      'data',
      Buffer.from(`__ORCA_LOGIN_SHELL_ENV_START__${printed}__ORCA_LOGIN_SHELL_ENV_END__`)
    )
    child.emit('close', 0)
  })
  return child
}

/** Windows without the registry addon (an Orca server slot); `savedPath` is each key's saved
 *  Path value, null when the key has none, answered the way reg.exe answers. */
async function withSimulatedWindowsServer(
  savedPath: (key: string) => string | null,
  run: () => Promise<void>
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  __setWindowsPathRegistryLoaderForTests(() => {
    throw new Error('Cannot find module @orca/windows-registry')
  })
  runProcessMock.mockImplementation(async ({ args }: { args: string[] }) => {
    const key = args[1] ?? ''
    const path = savedPath(key)
    if (path === null && args.includes('/v')) {
      const stderr = 'ERROR: The system was unable to find the specified registry key or value.'
      return { code: 1, signal: null, timedOut: false, stdout: '', stderr }
    }
    const lines = ['', key, '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp']
    if (path !== null) {
      lines.push(`    Path    REG_EXPAND_SZ    ${path}`)
    }
    return {
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout: [...lines, ''].join('\r\n')
    }
  })
  spawnProcessMock.mockImplementation(fakePowerShell)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await run()
  } finally {
    vi.useRealTimers()
    runProcessMock.mockReset()
    spawnProcessMock.mockReset()
    __setWindowsPathRegistryLoaderForTests()
    __resetPersistedWindowsPathCacheForTests()
    loginShell.resetLoginShellEnvironmentCacheForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  }
}

const shellEnv = {
  PATH: '/shell/bin',
  LANG: 'en_US.UTF-8',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  CODEX_LB_API_KEY: 'lb-key',
  ANTHROPIC_API_KEY: 'shell-key',
  CLAUDE_CONFIG_DIR: '/shell/claude',
  UNSET: undefined
}

const processEnv = { PATH: '/orca/bin', HOME: '/home/me', ORCA_USER_DATA_PATH: '/orca' }

describe('structuredAgentBaseEnvironment', () => {
  it('is the whole shell snapshot, and nothing else, when inheriting all', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: INHERIT_ALL,
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key',
      ANTHROPIC_API_KEY: 'shell-key',
      CLAUDE_CONFIG_DIR: '/shell/claude'
    })
  })

  it('passes only the baseline and listed shell names over Orca env when off', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      HOME: '/home/me',
      ORCA_USER_DATA_PATH: '/orca',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key'
    })
  })

  it('matches names case-insensitively on Windows without duplicating Path', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv: { PATH: 'C:\\shell', codex_lb_api_key: 'lb-key' },
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv: { Path: 'C:\\orca', USERPROFILE: 'C:\\Users\\me' },
        platform: 'win32'
      })
    ).toEqual({ PATH: 'C:\\shell', USERPROFILE: 'C:\\Users\\me', codex_lb_api_key: 'lb-key' })
  })
})

describe('createStructuredAgentEnvironmentResolvers', () => {
  it('loads the PowerShell profile once and refreshes only the saved PATH on Windows', async () => {
    let machineReads = 0
    await withSimulatedWindowsServer(
      (key) => {
        if (key.startsWith('HKLM')) {
          machineReads += 1
          return machineReads === 1 ? 'C:\\Windows' : 'C:\\Windows;C:\\NewTool'
        }
        return 'C:\\Users\\me\\bin'
      },
      async () => {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        const first = await resolvers.resolveBaseEnvironment()
        expect(first.PROFILE_ONLY).toBe('1')
        expect(pathSegments(first)).toEqual(
          expect.arrayContaining(['C:\\Windows', 'C:\\Users\\me\\bin'])
        )
        expect(pathSegments(first)).not.toContain('C:\\NewTool')
        vi.advanceTimersByTime(10_000)
        await resolvers.resolveBaseEnvironment()
        // A machine-wide install reaches new chats, and the profile's variables stay.
        await vi.waitFor(async () => {
          const refreshed = await resolvers.resolveBaseEnvironment()
          expect(pathSegments(refreshed)).toContain('C:\\NewTool')
          expect(refreshed.PROFILE_ONLY).toBe('1')
        })
        expect(spawnProcessMock).toHaveBeenCalledOnce()
        expect(spawnProcessMock).toHaveBeenCalledWith(
          expect.objectContaining({ program: 'powershell.exe' })
        )
      }
    )
  })

  it('keeps the machine PATH when the user has no saved Path value and reg.exe reads it', async () => {
    // An Orca server slot ships no registry addon, so this is the path a Windows SSH host takes.
    await withSimulatedWindowsServer(
      (key) => (key.startsWith('HKLM') ? 'C:\\Program Files\\nodejs\\;C:\\NewMachineTool' : null),
      async () => {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect(pathSegments(await resolvers.resolveBaseEnvironment())).toContain(
          'C:\\NewMachineTool'
        )
        expect(runProcessMock).toHaveBeenCalledWith(
          expect.objectContaining({
            program: expect.stringMatching(/reg\.exe$/i),
            args: ['query', 'HKCU\\Environment']
          })
        )
      }
    )
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the last good snapshot when a later login-shell capture fails',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-structured-shell-env-'))
      const counter = join(dir, 'count')
      const shell = join(dir, 'shell.sh')
      // Run 1 has the profile PATH, run 2 fails like a timed-out or broken profile, later runs succeed.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'`,
          'case $n in 1) p=/profile/A ;; 2) exit 1 ;; *) p=/profile/B ;; esac',
          'printf \'\\000__ORCA_LOGIN_SHELL_ENV_START__\\000PATH=%s\\000\\000__ORCA_LOGIN_SHELL_ENV_END__\\000\' "$p"',
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
        const served: (string | undefined)[] = []
        for (let start = 0; start < 200 && served.at(-1) !== '/profile/B'; start += 1) {
          // Every start is past the TTL, so each one after a refresh settles starts the next run.
          vi.advanceTimersByTime(10_000)
          served.push((await resolvers.resolveBaseEnvironment()).PATH)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(Number(await readFile(counter, 'utf8'))).toBeGreaterThanOrEqual(3)
        expect(served.at(-1)).toBe('/profile/B')
        // The failed run never served Orca's own env in place of the profile's.
        expect(served.filter((path) => path !== '/profile/A' && path !== '/profile/B')).toEqual([])
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        loginShell.resetLoginShellEnvironmentCacheForTests()
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'shares the login-shell run an earlier reader started instead of running the shell again',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-structured-shell-runs-'))
      const counter = join(dir, 'count')
      const shell = join(dir, 'shell.sh')
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'`,
          "printf '\\000__ORCA_LOGIN_SHELL_ENV_START__\\000PATH=/profile/bin\\000\\000__ORCA_LOGIN_SHELL_ENV_END__\\000'",
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      try {
        // Startup readers such as the Claude account router capture before the runtime exists.
        const early = loginShell.resolveLoginShellEnvironment()
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/bin')
        expect((await early).PATH).toBe('/profile/bin')
        expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        loginShell.resetLoginShellEnvironmentCacheForTests()
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('starts the first capture when created, before any chat asks for it', () => {
    const capture = vi.fn(async () => ({ PATH: '/shell/A' }))
    createStructuredAgentEnvironmentResolvers({ resolveEnvironment: capture })
    expect(capture).toHaveBeenCalledOnce()
  })

  // Windows reloads only the saved PATH, covered by the simulated-Windows case above.
  it.skipIf(process.platform === 'win32')(
    'serves the last snapshot to every start after the first and refreshes it past the TTL',
    async () => {
      const capture = vi
        .spyOn(loginShell, 'captureLoginShellEnvironment')
        .mockResolvedValueOnce({ status: 'captured', env: { PATH: '/shell/A' } })
        .mockResolvedValueOnce({ status: 'captured', env: { PATH: '/shell/B' } })
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({})
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/shell/A')
        expect((await resolvers.resolveClaudeInheritedEnv()).PATH).toBe('/shell/A')
        expect(capture).toHaveBeenCalledOnce()
        // The first capture may share a startup reader's run; refreshes must run the shell again.
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
        vi.advanceTimersByTime(10_000)
        // The stale start still gets the old snapshot; the install shows up on the next one.
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/shell/A')
        expect(capture).toHaveBeenCalledTimes(2)
        expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
        await new Promise((resolve) => setImmediate(resolve))
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/shell/B')
      } finally {
        vi.useRealTimers()
        capture.mockRestore()
      }
    }
  )

  it('makes only the first start wait on a slow profile', async () => {
    vi.useFakeTimers()
    try {
      let captures = 0
      const capture = vi.fn(
        () =>
          new Promise<NodeJS.ProcessEnv>((resolve) => {
            captures += 1
            const path = `/capture-${captures}`
            setTimeout(() => resolve({ PATH: path }), 2000)
          })
      )
      const resolvers = createStructuredAgentEnvironmentResolvers({ resolveEnvironment: capture })
      const first = resolvers.resolveBaseEnvironment()
      expect(await settledWithoutWaiting(first)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2000)
      expect((await first).PATH).toBe('/capture-1')
      for (const expected of ['/capture-1', '/capture-2', '/capture-3']) {
        // Each start is past the TTL, so it starts a 2 s refresh but must not wait for it.
        await vi.advanceTimersByTimeAsync(12_000)
        expect((await settledWithoutWaiting(resolvers.resolveBaseEnvironment()))?.PATH).toBe(
          expected
        )
      }
      expect(capture).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold later starts behind a hung profile', async () => {
    vi.useFakeTimers()
    try {
      // The first capture ends at the login-shell timeout with Orca's own env; later ones hang.
      const capture = vi
        .fn<() => Promise<NodeJS.ProcessEnv>>(() => new Promise(() => {}))
        .mockImplementationOnce(
          () => new Promise((resolve) => setTimeout(() => resolve({ PATH: '/fallback' }), 5000))
        )
      const resolvers = createStructuredAgentEnvironmentResolvers({ resolveEnvironment: capture })
      const first = resolvers.resolveBaseEnvironment()
      await vi.advanceTimersByTimeAsync(5000)
      expect((await first).PATH).toBe('/fallback')
      for (let start = 0; start < 3; start += 1) {
        await vi.advanceTimersByTimeAsync(10_000)
        expect((await settledWithoutWaiting(resolvers.resolveBaseEnvironment()))?.PATH).toBe(
          '/fallback'
        )
      }
      // The hung refresh is shared, not restarted per start.
      expect(capture).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares concurrent first captures and retries after a failed first capture', async () => {
    let release: (env: NodeJS.ProcessEnv) => void = () => {}
    const capture = vi.fn<() => Promise<NodeJS.ProcessEnv>>()
    capture.mockRejectedValueOnce(new Error('shell failed'))
    const resolvers = createStructuredAgentEnvironmentResolvers({ resolveEnvironment: capture })
    await expect(resolvers.resolveBaseEnvironment()).rejects.toThrow('shell failed')
    capture.mockImplementationOnce(
      () =>
        new Promise<NodeJS.ProcessEnv>((resolve) => {
          release = resolve
        })
    )
    const first = resolvers.resolveBaseEnvironment()
    const second = resolvers.resolveClaudeInheritedEnv()
    release({ PATH: '/repaired' })
    expect((await first).PATH).toBe('/repaired')
    expect((await second).PATH).toBe('/repaired')
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('rereads settings on every acquisition while the shell snapshot is cached', async () => {
    let overlay = 'A'
    const resolveEnvironment = vi.fn(async () => ({ PATH: '/shell/A' }))
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment,
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveLaunchEnvOverlay: () => ({ CURRENT_SETTING: overlay })
    })
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'A'
    })
    overlay = 'B'
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'B'
    })
    expect(resolveEnvironment).toHaveBeenCalledOnce()
  })

  it('gives Codex and Claude the same base, with overlays on Codex only', async () => {
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveCodexOverrides: () => ({ CODEX_PROFILE: 'p' })
    })
    expect(await resolvers.resolveClaudeInheritedEnv()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1',
      CODEX_PROFILE: 'p'
    })
  })
})
