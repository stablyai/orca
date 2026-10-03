import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import { finishPtyShutdown } from '../provider/liveness'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { ClaudeProfileRoutingService } from '../../../claude-accounts/claude-profile-routing-service'
import { createWslClaudeProfileOwner } from '../../../claude-accounts/claude-profile-wsl-owner'
import { WSL_CLAUDE_PROFILE_POINTER } from '../../../../shared/claude-profile-routing'

const profiles = vi.hoisted(() => {
  const state: { authority?: ClaudeProfileRoutingService } = {}
  return state
})
vi.mock('../../../claude-accounts/claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => profiles.authority
}))

const HOST_DEFAULT_SHELL = 'powershell.exe'
const hostPlatform = process.platform

function makeDeps(): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    store: undefined,
    getSettings: () => ({
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: HOST_DEFAULT_SHELL
    }),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `operations.ts` (write/clearBuffer) reads `mainWindow`; the spawn preflight and option build never touch it, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

/** Runs the preflight and option build the way `spawnPtyFromRuntimeController` sequences them. */
async function resolveSpawnShell(shellOverride: string | undefined): Promise<string | undefined> {
  const args: RuntimePtySpawnArgs = { cols: 120, rows: 40, shellOverride }
  const ctx = createRuntimePtySpawnState(makeDeps(), args)
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions.shellOverride
}

/**
 * Behavioural twin of `pty-spawn-shell-override-parity.test.ts`: a local Windows runtime spawn
 * (`terminal create --shell`, headless serve) must hand the caller's shell to the provider, not
 * the host default with the request typed into it.
 */
describe('runtime pty spawn preflight: requested shell on a local Windows host', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('spawns the requested shell as the pty', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(resolveSpawnShell('cmd.exe')).resolves.toBe('cmd.exe')
  })

  it('keeps the host default shell when nothing was requested', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(resolveSpawnShell(undefined)).resolves.toBe(HOST_DEFAULT_SHELL)
  })
})

describe('runtime pty spawn preflight: Claude profiles in a WSL pane', () => {
  afterEach(() => {
    profiles.authority = undefined
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('opens a wsl.exe pane on a stopped routed distro without waiting on the guest', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const booting = Promise.withResolvers<boolean>()
    const reachable = vi.fn(() => booting.promise)
    const prepareGuest = vi.fn(async (): Promise<never> => {
      throw new Error('unexpected guest call')
    })
    const settings = getDefaultSettings('/tmp')
    profiles.authority = new ClaudeProfileRoutingService(
      createWslClaudeProfileOwner(
        () => ({
          ...settings,
          claudeManagedAccounts: [
            {
              id: 'a',
              email: 'a@example.test',
              managedAuthPath: '/unused-legacy',
              authMethod: 'subscription-oauth',
              managedAuthRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              createdAt: 0,
              updatedAt: 0,
              lastAuthenticatedAt: 0
            }
          ],
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a' } }
        }),
        prepareGuest,
        async () => {},
        reachable
      )
    )
    const args: RuntimePtySpawnArgs = {
      cols: 120,
      rows: 40,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u',
      shellOverride: 'wsl.exe',
      env: { KEEP: '1' }
    }
    const ctx = createRuntimePtySpawnState(makeDeps(), args)
    await expect(prepareRuntimePtySpawn(ctx)).resolves.toBeNull()
    expect(ctx.codexSelectionTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(args.env).toEqual({ KEEP: '1', ORCA_CLAUDE_PROFILE_POINTER: WSL_CLAUDE_PROFILE_POINTER })
    // The background republish waits for the pane to boot the distro; the pane did not wait.
    expect(reachable).toHaveBeenCalledWith('Ubuntu')
    expect(prepareGuest).not.toHaveBeenCalled()
    booting.resolve(false)
  })

  it('gives a wsl.exe pane in a distro with no Orca account nothing, as before profiles', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const prepareGuest = vi.fn(async (): Promise<never> => {
      throw new Error('unexpected guest call')
    })
    profiles.authority = new ClaudeProfileRoutingService(
      createWslClaudeProfileOwner(
        () => getDefaultSettings('/tmp'),
        prepareGuest,
        async () => {},
        async () => true
      )
    )
    const args: RuntimePtySpawnArgs = {
      cols: 120,
      rows: 40,
      cwd: '\\\\wsl.localhost\\Arch\\home\\u',
      shellOverride: 'wsl.exe',
      env: { KEEP: '1' }
    }
    const ctx = createRuntimePtySpawnState(makeDeps(), args)
    await expect(prepareRuntimePtySpawn(ctx)).resolves.toBeNull()
    expect(args.env).toEqual({ KEEP: '1' })
    expect(prepareGuest).not.toHaveBeenCalled()
  })
})
