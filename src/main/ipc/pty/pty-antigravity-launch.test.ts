import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type * as WindowsShellExecutable from '../../providers/windows-powershell-executable'
import {
  getAntigravityAccountVaultPath,
  getAntigravityAccountService
} from '../../antigravity/native-account-host'
import { createEncryptedAntigravityAccountStore } from '../../antigravity/native-account-store'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { prepareRuntimePtySpawn } from './runtime/spawn-preflight'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import { finishPtyShutdown } from './provider/liveness'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  resolveCodexResumeLaunch,
  reconcileSharedRuntimeResumeHome,
  stripSequencedStartupResumeArgv
} from './host-env/codex-resume'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// The filesystem double has no real Windows executables; pin only shell discovery.
vi.mock('../../providers/windows-powershell-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsShellExecutable>()),
  resolveWindowsPowerShellExecutablePath: () =>
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  resolveWindowsPowerShellSpawnChain: () => [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ]
}))

vi.mock('../../antigravity/native-account-host', () => ({
  getAntigravityAccountVaultPath: vi.fn(() => {
    throw new Error('launch observed account vault')
  }),
  getAntigravityAccountService: vi.fn(() => {
    throw new Error('launch observed native account')
  })
}))
vi.mock('../../antigravity/native-account-store', () => ({
  createEncryptedAntigravityAccountStore: vi.fn(() => {
    throw new Error('launch read account store')
  })
}))

// These commands test shell-text transport, not the shell's argv or the agent's parser.
const commands = [
  'agy',
  'agy --gemini_dir other --app_data_dir custom',
  'agy -i "" --gemini_dir other --prompt-interactive hello',
  'agy -p "--gemini_dir=other" --prompt hello',
  'my-agy-alias --custom-option "unchanged value"'
]
const env = {
  USERPROFILE: 'C:\\Users\\explicit',
  HOME: 'C:\\other',
  GEMINI_HOME: 'C:\\acp-independent',
  SSH_CLIENT: 'explicit-detector',
  MIXED_case: '  opaque value  ',
  REMOVE_ME: 'deleted'
}

function runtimeDeps(): PtyRuntimeControllerDeps {
  return {
    prepareCodexResumeHome: (args) => prepareCodexResumeHome(undefined, args),
    noCodexResumeLaunch,
    resolveCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    assertWorkspaceAcceptsNewPty: () => {},
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => true,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map()
  }
}

function expectNoAccountObservation() {
  expect(getAntigravityAccountVaultPath).not.toHaveBeenCalled()
  expect(getAntigravityAccountService).not.toHaveBeenCalled()
  expect(createEncryptedAntigravityAccountStore).not.toHaveBeenCalled()
}

describe('Windows agy command ownership at PTY spawn boundaries', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(getAntigravityAccountVaultPath).mockClear()
    vi.mocked(getAntigravityAccountService).mockClear()
    vi.mocked(createEncryptedAntigravityAccountStore).mockClear()
  })
  afterEach(() => vi.restoreAllMocks())

  it.each(commands)(
    'preserves renderer/configured/restored command and local provider env: %s',
    async (command) => {
      const launchAgent = command === 'agy' ? undefined : 'antigravity'
      const providerSpawn = vi.spyOn(LocalPtyProvider.prototype, 'spawn')
      const configure = vi.spyOn(LocalPtyProvider.prototype, 'configure')
      registerPtyHandlers(mainWindow)
      const configured = configure.mock.calls.at(-1)?.[0]
      expect(configured?.buildSpawnEnv).toBeTypeOf('function')
      if (!configured?.buildSpawnEnv) {
        throw new Error('local provider not configured')
      }
      const localEnv = vi.spyOn(configured, 'buildSpawnEnv')
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command,
        env: { ...env },
        envToDelete: ['REMOVE_ME'],
        launchAgent,
        commandDelivery: 'provider',
        spawnIntent: 'automatic-restore',
        launchConfig: { agentCommand: command, agentArgs: '', agentEnv: { ...env } }
      })
      expect(providerSpawn.mock.calls.at(-1)?.[0]).toMatchObject({
        command,
        spawnIntent: 'automatic-restore'
      })
      expect(providerSpawn.mock.calls.at(-1)?.[0].launchAgent).toBe(launchAgent)
      expect(localEnv).toHaveBeenCalled()
      expect(localEnv.mock.calls.at(-1)?.[2]).toMatchObject({
        command,
        launchAgent,
        isWsl: false
      })
      const spawnCall = spawnMock.mock.calls.at(-1)
      expect(spawnCall).toBeDefined()
      const shellArgs: string[] = spawnCall![1]
      const encodedIndex = shellArgs.indexOf('-EncodedCommand')
      expect(encodedIndex).toBeGreaterThanOrEqual(0)
      expect(
        Buffer.from(shellArgs[encodedIndex + 1], 'base64')
          .toString('utf16le')
          .endsWith(`\n${command}`)
      ).toBe(true)
      const childEnv = spawnCall![2].env
      for (const [key, value] of Object.entries(env)) {
        expect(childEnv[key]).toBe(key === 'REMOVE_ME' ? undefined : value)
      }
      expectNoAccountObservation()
    }
  )

  it('returns a configured startup unchanged when the renderer owns command delivery', async () => {
    const launchConfig = { agentCommand: commands[2], agentArgs: '', agentEnv: { ...env } }
    const providerSpawn = vi.spyOn(LocalPtyProvider.prototype, 'spawn')
    registerPtyHandlers(mainWindow)
    const result = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      launchConfig,
      launchAgent: 'antigravity',
      env: { ...env },
      commandDelivery: 'renderer',
      spawnIntent: 'automatic-restore'
    })
    expect(result).toMatchObject({ launchConfig })
    expect(providerSpawn.mock.calls.at(-1)?.[0].command).toBeUndefined()
    expectNoAccountObservation()
  })

  it.each(commands)('preserves runtime spawn construction: %s', async (command) => {
    const ctx = createRuntimePtySpawnState(runtimeDeps(), {
      cols: 80,
      rows: 24,
      command,
      env: { ...env },
      envToDelete: ['REMOVE_ME'],
      launchAgent: 'antigravity',
      spawnIntent: 'automatic-restore'
    })
    await prepareRuntimePtySpawn(ctx)
    await buildRuntimePtySpawnOptions(ctx)
    try {
      expect(ctx.spawnOptions).toMatchObject({
        command,
        launchAgent: 'antigravity',
        spawnIntent: 'automatic-restore'
      })
      for (const [key, value] of Object.entries(env)) {
        expect(ctx.spawnOptions.env?.[key]).toBe(key === 'REMOVE_ME' ? undefined : value)
      }
      expectNoAccountObservation()
    } finally {
      ctx.finishTerminalInstall()
    }
  })
})
