import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as loginShell from '../startup/login-shell-environment'
import type * as runProcessModule from '@orca/process-host'
import {
  __resetPersistedWindowsPathCacheForTests,
  readPersistedWindowsPathSegmentsAsync
} from '../pty/windows-environment-path'
import { resolveAgainAfterRefreshOnMissingProgram } from '../native-chat/structured-agent-command-resolution'
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

afterEach(loginShell.resetLoginShellEnvironmentCacheForTests)

function pathSegments(env: Record<string, string>): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
  return key ? (env[key]?.split(';') ?? []) : []
}

/** A powershell.exe child that prints the env it was given plus one profile-only variable, or,
 *  when `failed`, exits without printing it, as a profile that errors does. */
function fakePowerShell(spec: { env: NodeJS.ProcessEnv }, failed = false): EventEmitter {
  const stdout = new EventEmitter()
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: () => {} }),
    stdout,
    stderr: Object.assign(new EventEmitter(), { resume: () => {} }),
    kill: () => true
  })
  const printed = JSON.stringify({ ...spec.env, PROFILE_ONLY: '1' })
  setImmediate(() => {
    if (!failed) {
      stdout.emit(
        'data',
        Buffer.from(`__ORCA_LOGIN_SHELL_ENV_START__${printed}__ORCA_LOGIN_SHELL_ENV_END__`)
      )
    }
    child.emit('close', failed ? 1 : 0)
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
        // Past the saved PATH cache's own 30 s.
        vi.advanceTimersByTime(30_000)
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

  it('retries a failed first PowerShell profile load on a later refresh, then stops', async () => {
    let profileFails = true
    await withSimulatedWindowsServer(
      () => 'C:\\Windows',
      async () => {
        spawnProcessMock.mockImplementation((spec: { env: NodeJS.ProcessEnv }) =>
          fakePowerShell(spec, profileFails)
        )
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PROFILE_ONLY).toBeUndefined()
        const failedRuns = spawnProcessMock.mock.calls.length
        profileFails = false
        vi.advanceTimersByTime(10_000)
        await resolvers.resolveBaseEnvironment()
        await vi.waitFor(async () => {
          expect((await resolvers.resolveBaseEnvironment()).PROFILE_ONLY).toBe('1')
        })
        expect(spawnProcessMock).toHaveBeenCalledTimes(failedRuns + 1)
        // Once loaded, a refresh rereads only the saved PATH.
        const registryReads = runProcessMock.mock.calls.length
        vi.advanceTimersByTime(30_000)
        await resolvers.resolveBaseEnvironment()
        await vi.waitFor(() => {
          expect(runProcessMock.mock.calls.length).toBeGreaterThan(registryReads)
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(spawnProcessMock).toHaveBeenCalledTimes(failedRuns + 1)
        expect((await resolvers.resolveBaseEnvironment()).PROFILE_ONLY).toBe('1')
      }
    )
  })

  it('retries a failed PowerShell profile 10 s after the last attempt, however often launches miss', async () => {
    let machinePath = 'C:\\Windows'
    let profileFails = true
    await withSimulatedWindowsServer(
      (key) => (key.startsWith('HKLM') ? machinePath : null),
      async () => {
        spawnProcessMock.mockImplementation((spec: { env: NodeJS.ProcessEnv }) =>
          fakePowerShell(spec, profileFails)
        )
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        await resolvers.resolveBaseEnvironment()
        const failedRuns = spawnProcessMock.mock.calls.length
        expect(failedRuns).toBeGreaterThan(0)
        machinePath = 'C:\\Windows;C:\\NewTool'
        profileFails = false
        // A launch misses every 9 s; each miss rereads the saved PATH, and the next start reads.
        vi.advanceTimersByTime(9_000)
        await resolvers.refreshAfterMissingProgram(Date.now())
        const afterMiss = await resolvers.resolveBaseEnvironment()
        expect(pathSegments(afterMiss)).toContain('C:\\NewTool')
        expect(spawnProcessMock).toHaveBeenCalledTimes(failedRuns)
        vi.advanceTimersByTime(9_000)
        await resolvers.refreshAfterMissingProgram(Date.now())
        await resolvers.resolveBaseEnvironment()
        // 18 s after the failed attempt, however recent the saved PATH reread.
        await vi.waitFor(async () => {
          expect((await resolvers.resolveBaseEnvironment()).PROFILE_ONLY).toBe('1')
        })
        expect(spawnProcessMock).toHaveBeenCalledTimes(failedRuns + 1)
      }
    )
  })

  it('answers a Windows miss with a saved PATH read started after it looked, not one before the install', async () => {
    let machinePath = 'C:\\Windows'
    await withSimulatedWindowsServer(
      (key) => (key.startsWith('HKLM') ? machinePath : null),
      async () => {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        await resolvers.resolveBaseEnvironment()
        // A read that queried the registry before the install is still going.
        const answer = runProcessMock.getMockImplementation()!
        const held = Promise.withResolvers<void>()
        runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
          const result = await answer(spec)
          await held.promise
          return result
        })
        const beforeInstall = readPersistedWindowsPathSegmentsAsync({ forceRefresh: true })
        runProcessMock.mockImplementation(answer)
        machinePath = 'C:\\Windows;C:\\NewTool'
        vi.advanceTimersByTime(1)
        const miss = resolvers.refreshAfterMissingProgram(Date.now())
        await Promise.race([miss, new Promise((resolve) => setTimeout(resolve, 500))])
        held.resolve()
        await Promise.all([miss, beforeInstall])
        expect(pathSegments(await resolvers.resolveBaseEnvironment())).toContain('C:\\NewTool')
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

  it.skipIf(process.platform === 'win32')(
    'retries a launch on a shell run started after it looked, not on one that predates an install',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-structured-shell-install-'))
      const [counter, pathFile, hold, shell] = ['count', 'path', 'hold', 'shell.sh'].map((name) =>
        join(dir, name)
      )
      // Run 2 reads PATH, then waits while `hold` exists: a background rerun still going.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'; n=$(wc -l < '${counter}'); p=$(cat '${pathFile}')`,
          `if [ $n -eq 2 ]; then while [ -f '${hold}' ]; do sleep 0.02; done; fi`,
          'printf \'\\000__ORCA_LOGIN_SHELL_ENV_START__\\000PATH=%s\\000\\000__ORCA_LOGIN_SHELL_ENV_END__\\000\' "$p"',
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      await writeFile(pathFile, '/old')
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/old')
        await writeFile(hold, '')
        vi.advanceTimersByTime(10_000)
        await resolvers.resolveBaseEnvironment()
        await vi.waitFor(async () =>
          expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2)
        )
        await writeFile(pathFile, '/installed')
        vi.advanceTimersByTime(1)
        const launch = resolveAgainAfterRefreshOnMissingProgram(
          async () => {
            const { PATH } = await resolvers.resolveBaseEnvironment()
            return { command: PATH === '/installed' ? '/installed/agent' : 'agent', PATH }
          },
          resolvers.refreshAfterMissingProgram,
          { env: ({ PATH }) => ({ PATH }) }
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        await rm(hold, { force: true })
        expect((await launch).command).toBe('/installed/agent')
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'holds a miss for at most one shell timeout when the login shell hangs, keeping the snapshot',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-structured-shell-hang-'))
      const [counter, shell] = ['count', 'shell.sh'].map((name) => join(dir, name))
      // Run 1 answers; every later run hangs, as a profile stuck on a prompt does.
      await writeFile(
        shell,
        [
          '#!/bin/sh',
          `echo run >> '${counter}'; n=$(wc -l < '${counter}')`,
          'if [ $n -gt 1 ]; then exec sleep 30; fi',
          "printf '\\000__ORCA_LOGIN_SHELL_ENV_START__\\000PATH=/profile/A\\000\\000__ORCA_LOGIN_SHELL_ENV_END__\\000'",
          ''
        ].join('\n')
      )
      await chmod(shell, 0o755)
      const originalShell = process.env.SHELL
      process.env.SHELL = shell
      try {
        const resolvers = createStructuredAgentEnvironmentResolvers({
          resolveShellEnvironmentPolicy: () => INHERIT_ALL
        })
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        let released = false
        void resolvers.refreshAfterMissingProgram(Date.now()).then(() => {
          released = true
        })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(released).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(released).toBe(true)
        expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/profile/A')
      } finally {
        vi.useRealTimers()
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
        await rm(dir, { recursive: true, force: true })
      }
    },
    // Real shell spawns; a loaded runner can take seconds for the first one.
    20_000
  )

  it('rereads settings on every acquisition while the shell env is read once', async () => {
    let overlay = 'A'
    const resolveEnvironment = vi.fn(async () => ({ PATH: '/shell/A' }))
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment,
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveAgentLaunchEnv: () => ({ CURRENT_SETTING: overlay })
    })
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'A'
    })
    overlay = 'B'
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'B'
    })
    expect(resolveEnvironment).toHaveBeenCalledOnce()
  })

  it("gives every agent the same base, with each agent's own overlay on it", async () => {
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveAgentLaunchEnv: (agent): Record<string, string> =>
        agent === 'codex' ? { CODEX_PROFILE: 'p' } : {}
    })
    expect(await resolvers.resolveBaseEnvironment()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('claude')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1',
      CODEX_PROFILE: 'p'
    })
  })
})
