import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const fixture = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.userData,
    getVersion: () => '1.4.0',
    getAppPath: () => fixture.userData,
    isPackaged: false
  },
  BrowserWindow: { getAllWindows: () => [] },
  net: { isOnline: () => false }
}))
vi.mock('../plugins/plugin-image-protocol', () => ({ installPluginImageProtocolHandler: vi.fn() }))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ rebuildSystemTrayMenu: vi.fn() }))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { subscribeEnrichedStatus: vi.fn() }
}))
vi.mock('./main-process-pty-startup', () => ({ emitPluginWorktreeLifecycle: vi.fn() }))

const { initializeMainProcessPlugins } = await import('./main-process-plugins')
const { mainProcessState: state } = await import('./main-process-state')
const { PluginService } = await import('../plugins/plugin-service')
const { setPluginServiceForRpc } = await import('../runtime/rpc/methods/plugins')

afterEach(async () => {
  await state.pluginService?.dispose()
  state.pluginService = null
  setPluginServiceForRpc(null)
  vi.restoreAllMocks()
  await rm(fixture.userData, { recursive: true, force: true })
})

// A headless serve never opens a window, so nothing here may depend on IPC registration.
it('binds the runtime and exactly one settings→refresh listener without any window', async () => {
  fixture.userData = await mkdtemp(join(tmpdir(), 'orca-main-plugins-'))
  const settingsListeners: ((updates: Record<string, unknown>) => void)[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin startup reads settings and subscribes to settings changes and session writes only.
  state.store = {
    getSettings: () => ({ pluginSystemEnabled: false }),
    onSettingsChanged: (listener: (updates: Record<string, unknown>) => void) => {
      settingsListeners.push(listener)
      return () => {}
    },
    onWorkspaceSessionWritten: () => () => {}
  } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin startup reads only keybinding overrides.
  state.keybindings = { getOverrides: () => ({}) } as never
  const setRuntimeDelegate = vi.spyOn(PluginService.prototype, 'setRuntimeDelegate')
  const refresh = vi.spyOn(PluginService.prototype, 'refresh')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup only subscribes to worktree lifecycle on the runtime.
  const runtime = { onWorktreeLifecycle: vi.fn() } as unknown as OrcaRuntimeService

  await initializeMainProcessPlugins(runtime)
  await state.pluginService?.whenReady()
  refresh.mockClear()

  // The runtime, plus the hook server's agent rows for agents.list.
  expect(setRuntimeDelegate).toHaveBeenCalledWith(
    expect.objectContaining({ listAgentStatuses: expect.any(Function) })
  )
  for (const listener of settingsListeners) {
    listener({ devPluginPaths: [] })
  }
  expect(refresh).toHaveBeenCalledOnce()
})
