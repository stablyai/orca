import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAntigravityAccountForLaunch } from '../../antigravity/native-account-launch'
import { assemblePtyIpcSpawnEnv } from './ipc/spawn-env'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import { configureLocalPtyProvider } from './provider/local-configure'
import { localProvider } from './provider/registry'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'

vi.mock('../../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn()
}))
vi.mock('./host-env/assembly', () => ({
  buildPtyHostEnv: (_id: string, env: Record<string, string>) => env
}))
vi.mock('./ipc/spawn-env-codex', () => ({ assemblePtyIpcSpawnCodexEnv: vi.fn() }))
const args = {
  cols: 80,
  rows: 24,
  launchAgent: 'antigravity',
  command: 'agy',
  env: {},
  envToDelete: ['HOME']
} as const
afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(prepareAntigravityAccountForLaunch)
    .mockReset()
    .mockResolvedValue({ wslDistro: 'Ubuntu-24.04', authorityId: 'a'.repeat(64) })
})
describe('Antigravity WSL launch target at PTY entrypoints', () => {
  it('passes the desktop target and pins the final provider options', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these two stages only use the stubbed delivery callbacks; worktree/runtime-dependent branches are disabled.
    const deps = {
      transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
      syncPtyBackgroundedDelivery: vi.fn(),
      sendPtySpawnedToRenderer: vi.fn()
    } as unknown as PtySpawnIpcDeps
    const ctx = createPtyIpcSpawnState(deps, { ...args, envToDelete: [...args.envToDelete] })
    ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    ctx.expectedWslDistro = 'Ubuntu'
    await assemblePtyIpcSpawnEnv(ctx)
    await buildPtyIpcSpawnOptions(ctx)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ isWsl: true, wslDistro: 'Ubuntu', envToDelete: ['HOME'] })
    )
    expect(ctx.spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu-24.04')
    expect(ctx.expectedWslDistro).toBe('Ubuntu-24.04')
  })
  it('passes the headless target and pins the final provider options', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildRuntimePtySpawnOptions has no runtime or store and reads only these callbacks.
    const deps = {
      sendPtySpawnedToRenderer: vi.fn(),
      trustedTerminalHandleEnv: new Set<string>(),
      sendPtyExitToRenderer: vi.fn()
    } as unknown as PtyRuntimeControllerDeps
    const ctx = createRuntimePtySpawnState(deps, { ...args, envToDelete: [...args.envToDelete] })
    ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    ctx.expectedWslDistro = 'Ubuntu'
    ctx.launchCommand = 'agy'
    ctx.env = {}
    await buildRuntimePtySpawnOptions(ctx)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        isWsl: true,
        wslDistro: 'Ubuntu',
        envToDelete: expect.arrayContaining(['HOME'])
      })
    )
    expect(ctx.spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu-24.04')
    expect(ctx.expectedWslDistro).toBe('Ubuntu-24.04')
  })
  it('binds the configured local provider to the prepared target before hook environment assembly', async () => {
    if (!(localProvider instanceof LocalPtyProvider)) {
      throw new Error('Expected local provider fixture')
    }
    const configure = vi.spyOn(localProvider, 'configure')
    configureLocalPtyProvider({ trustedTerminalHandleEnv: new Set() })
    const build = configure.mock.calls[0]?.[0].buildSpawnEnv
    if (!build) {
      throw new Error('Expected environment builder')
    }
    const pinWslDistro = vi.fn()
    const context = {
      isWsl: true,
      wslDistro: 'Ubuntu',
      command: 'agy',
      launchAgent: 'antigravity' as const,
      envToDelete: ['HOME'],
      pinWslDistro
    }
    await build('test-pty', {}, context)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        isWsl: true,
        wslDistro: 'Ubuntu',
        envIsComplete: true,
        envToDelete: ['HOME']
      })
    )
    expect(pinWslDistro).toHaveBeenCalledWith('Ubuntu-24.04')
    expect(context.wslDistro).toBe('Ubuntu-24.04')
  })
})
