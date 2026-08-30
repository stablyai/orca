import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type * as NodeOs from 'node:os'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type * as WindowsShellFallbackChain from './windows-shell-fallback-chain'
import { spawnShellWithFallback, type WindowsShellSpawnAttempt } from './local-pty-utils'

const { osReleaseMock, buildSpawnAttemptsMock } = vi.hoisted(() => ({
  osReleaseMock: vi.fn(() => '10.0.22000'),
  buildSpawnAttemptsMock: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  release: osReleaseMock
}))

vi.mock('./windows-shell-fallback-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsShellFallbackChain>()),
  buildWindowsPowerShellSpawnAttempts: buildSpawnAttemptsMock
}))

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original })
}

let restorePlatform: (() => void) | null = null
afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
  vi.restoreAllMocks()
})

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

function makeLocalLaunchPlan(shellPath: string): LocalPtyLaunchPlan {
  return {
    commandNonce: 'local-command-nonce',
    expectedCommandNonce: 'local-command-nonce',
    startupAgentRecognition: null,
    defaultCwd: 'C:\\repo',
    cwd: 'C:\\repo',
    wslInfo: null,
    worktreeWslContext: undefined,
    preferredWslContext: undefined,
    launchWslContext: undefined,
    shellPath,
    shellArgs: ['-NoLogo'],
    effectiveCwd: 'C:\\repo',
    validationCwd: 'C:\\repo',
    startupCommandDeliveredInShellArgs: false,
    windowsFallbackAttempts: [],
    shellReadyLaunch: null,
    getFallbackShellReadyConfig: undefined,
    primaryLaunchEnvKeys: [],
    isWslShell: false,
    launchWslDistro: null
  }
}

function makeFakePty(): pty.IPty {
  return { pid: 1234 } as unknown as pty.IPty
}

function makeAttempt(
  shellPath: string,
  overrides: Partial<WindowsShellSpawnAttempt> = {}
): WindowsShellSpawnAttempt {
  return {
    shellPath,
    shellArgs: ['-NoLogo'],
    effectiveCwd: 'C:\\repo',
    validationCwd: 'C:\\repo',
    startupCommandDeliveredInShellArgs: false,
    ...overrides
  }
}

// error code 5 == ERROR_ACCESS_DENIED from CreateProcessW inside ConPTY when a
// bare/alias pwsh.exe is handed to node-pty.
const ACCESS_DENIED_5 = 'Cannot create process, error code: 5'

describe('spawnShellWithFallback on Windows', () => {
  it.each([
    { release: '10.0.21999', trusted: false },
    { release: '10.0.22000', trusted: true }
  ])(
    'passes the Win10/Win11 nonce decision through the local finalizer and daemon launch plan ($release)',
    ({ release, trusted }) => {
      restorePlatform = setPlatform('win32')
      osReleaseMock.mockReturnValue(release)
      buildSpawnAttemptsMock.mockImplementation(
        ({
          shellPath,
          cwd,
          defaultCwd
        }: {
          shellPath: string
          cwd: string
          defaultCwd: string
        }) => [
          {
            shellPath,
            shellArgs: ['-NoLogo'],
            effectiveCwd: cwd,
            validationCwd: defaultCwd,
            startupCommandDeliveredInShellArgs: false
          }
        ]
      )

      const localPlan = makeLocalLaunchPlan(PWSH7)
      const localEnv: Record<string, string> = {
        ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE: '1',
        ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE: '1'
      }
      finalizeLocalPtySpawnEnvironment({
        spawn: { cols: 80, rows: 24 },
        getOptions: () => ({ isHistoryEnabled: () => false }),
        plan: localPlan,
        env: localEnv
      })

      const daemonEnv: Record<string, string> = {
        ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE: '1',
        ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE: '1'
      }
      const daemonPlan = createPtyShellLaunchPlan(
        {
          sessionId: 'daemon-session',
          cols: 80,
          rows: 24,
          cwd: 'C:\\repo',
          shellOverride: PWSH7,
          terminalWindowsPowerShellImplementation: 'pwsh.exe'
        },
        daemonEnv
      )

      for (const [name, plan, env] of [
        ['local', localPlan, localEnv],
        ['daemon', daemonPlan, daemonEnv]
      ] as const) {
        expect(env.ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE, name).toBeUndefined()
        expect(env.ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE, name).toBeUndefined()
        expect(env.ORCA_SHELL_INTEGRATION_CONTEXT, name).toBe('direct')
        if (trusted) {
          const expectedNonce =
            name === 'local'
              ? (plan as LocalPtyLaunchPlan).expectedCommandNonce
              : (plan as ReturnType<typeof createPtyShellLaunchPlan>).shellCommandNonce
          expect(env.ORCA_SHELL_COMMAND_NONCE, name).toBe(expectedNonce)
        } else {
          expect(env.ORCA_SHELL_COMMAND_NONCE, name).toBeUndefined()
        }
      }

      // The local cmd.exe fallback scrub receives these names from the
      // finalizer, even when the Win10 policy intentionally omitted the nonce.
      expect(localPlan.primaryLaunchEnvKeys).toEqual(
        expect.arrayContaining(['ORCA_SHELL_COMMAND_NONCE', 'ORCA_SHELL_INTEGRATION_CONTEXT'])
      )
    }
  )

  it('repro: recovers when the primary PowerShell spawn fails with error code 5', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD, { shellArgs: ['/K', 'chcp 65001 > nul'] })
    ]

    const ptySpawn = vi.fn((shellPath: string) => {
      if (shellPath === PWSH7) {
        throw new Error(ACCESS_DENIED_5)
      }
      return makeFakePty()
    }) as unknown as typeof pty.spawn

    const result = spawnShellWithFallback({
      shellPath: PWSH7,
      shellArgs: attempts[0].shellArgs,
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      env: {},
      ptySpawn,
      windowsFallbackAttempts: attempts
    })

    // Falls back to the next real absolute executable instead of throwing.
    expect(result.shellPath).toBe(WINDOWS_POWERSHELL)
    expect(ptySpawn).toHaveBeenNthCalledWith(
      1,
      PWSH7,
      attempts[0].shellArgs,
      expect.objectContaining({ cwd: 'C:\\repo', useConptyDll: true })
    )
    expect(ptySpawn).toHaveBeenNthCalledWith(
      2,
      WINDOWS_POWERSHELL,
      attempts[1].shellArgs,
      expect.objectContaining({ cwd: 'C:\\repo', useConptyDll: true })
    )
  })

  it('falls all the way through to cmd.exe and surfaces its argv-delivery flag', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD, {
        shellArgs: ['/K', 'chcp 65001 > nul & npm start'],
        startupCommandDeliveredInShellArgs: true
      })
    ]

    const ptySpawn = vi.fn((shellPath: string) => {
      if (shellPath === CMD) {
        return makeFakePty()
      }
      throw new Error(ACCESS_DENIED_5)
    }) as unknown as typeof pty.spawn

    const env = {
      ORCA_SHELL_COMMAND_NONCE: 'private-nonce',
      ORCA_SHELL_INTEGRATION_CONTEXT: 'direct'
    }
    const result = spawnShellWithFallback({
      shellPath: PWSH7,
      shellArgs: attempts[0].shellArgs,
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      env,
      launchEnvKeys: ['ORCA_SHELL_COMMAND_NONCE', 'ORCA_SHELL_INTEGRATION_CONTEXT'],
      ptySpawn,
      windowsFallbackAttempts: attempts
    })

    expect(result.shellPath).toBe(CMD)
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    expect(env).toEqual({})
  })

  it('throws a descriptive error when every Windows fallback fails', () => {
    restorePlatform = setPlatform('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const attempts: WindowsShellSpawnAttempt[] = [
      makeAttempt(PWSH7),
      makeAttempt(WINDOWS_POWERSHELL),
      makeAttempt(CMD)
    ]
    const ptySpawn = vi.fn(() => {
      throw new Error(ACCESS_DENIED_5)
    }) as unknown as typeof pty.spawn
    const previousVersion = process.env.ORCA_APP_VERSION
    process.env.ORCA_APP_VERSION = '1.4.178-test'

    try {
      expect(() =>
        spawnShellWithFallback({
          shellPath: PWSH7,
          shellArgs: attempts[0].shellArgs,
          cols: 80,
          rows: 24,
          cwd: 'C:\\repo',
          env: {},
          ptySpawn,
          windowsFallbackAttempts: attempts
        })
      ).toThrow(/Failed to spawn shell.*orca: 1\.4\.178-test/)
    } finally {
      if (previousVersion === undefined) {
        delete process.env.ORCA_APP_VERSION
      } else {
        process.env.ORCA_APP_VERSION = previousVersion
      }
    }
  })
})
