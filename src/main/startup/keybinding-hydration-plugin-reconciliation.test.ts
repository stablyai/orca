import { expect, it, vi } from 'vitest'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { PluginService } from '../plugins/plugin-service'
import type { KeybindingFileSnapshot } from '../../shared/keybindings'
import type { AppState } from '../../renderer/src/store/types'
import { createKeybindingsSlice } from '../../renderer/src/store/slices/keybindings'

const fixture = vi.hoisted(() => {
  const state: {
    keybindings: KeybindingService | null
    pluginService: Pick<PluginService, 'reconcileActivationState'> | null
    [key: string]: unknown
  } = {
    store: {
      getSettings: () => ({}),
      onSettingsChanged: () => {},
      migrateLegacyOpenCodeGoApiKey: () => {}
    },
    claudeUsage: {},
    codexUsage: {},
    openCodeUsage: {},
    museUsage: {},
    keybindings: null,
    pluginService: null
  }
  return {
    state,
    prepare: vi.fn(),
    send: vi.fn<(channel: string, snapshot: KeybindingFileSnapshot) => void>()
  }
})
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))
vi.mock('electron', () => ({
  app: { getPath: () => '/test-home' },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: fixture.send } }]
  }
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: () => {} }))
vi.mock('../filesystem-host/filesystem-host-read-client', () => ({
  hydrateFilesystemHostFailureDomains: () => {},
  prepareKeybindingsThroughFilesystemHost: fixture.prepare
}))
vi.mock('../rate-limits/grok-auth-snapshot', () => ({ refreshGrokAuthSnapshot: async () => {} }))
vi.mock('../provider-account-services', () => ({ createProviderAccountServices: () => ({}) }))
vi.mock('../codex/codex-session-migration-scheduler', () => ({
  createCodexSessionMigrationScheduler: () => ({
    requestRun: () => {},
    scheduleInitialRun: () => {}
  })
}))
vi.mock('../codex/codex-session-backfill', () => ({
  startCodexSessionBackfillInBackground: () => {}
}))
vi.mock('../codex/codex-session-index-heal', () => ({
  startCodexSessionIndexHealInBackground: () => {}
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: async () => {}
}))
vi.mock('../codex/codex-home-paths', () => ({ getOrcaManagedCodexHomePath: () => '/test-home' }))
vi.mock('../opencode/opencode-go-api-key-store', () => ({
  hasOpenCodeGoApiKey: () => false,
  readOpenCodeGoApiKey: () => null,
  saveOpenCodeGoApiKey: () => {}
}))
vi.mock('../agent-hooks/server', () => ({ agentHookServer: {} }))
vi.mock('../codex/codex-session-source-home', () => ({
  resolveHostCodexSessionSourceHome: () => '/test-home'
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: { setSettingsResolver: () => {} } }))
vi.mock('../runtime/structured-agent-model-catalog-wiring', () => ({
  prewarmStructuredAgentModelCatalogs: () => {}
}))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-store', () => ({
  agentModelCatalogStore: {}
}))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-account-expiry', () => ({
  createAgentModelCatalogSettingsExpiry: () => () => {}
}))

it.each(['before', 'after'] as const)(
  'reconciles plugins when overrides hydrate %s plugin construction',
  async (timing) => {
    vi.resetModules()
    fixture.state.pluginService = null
    const set = vi.fn<Parameters<typeof createKeybindingsSlice>[0]>()
    const get = (): AppState => {
      throw new Error('Unexpected renderer state read')
    }
    const renderer = createKeybindingsSlice(set, get, {
      setState: set,
      getState: get,
      getInitialState: get,
      subscribe: () => () => {}
    })
    fixture.send.mockReset().mockImplementation((channel, snapshot) => {
      if (channel === 'keybindings:changed') renderer.setKeybindingSnapshot(snapshot)
    })
    let complete!: (value: { contents: string; seedCompleted: boolean }) => void
    fixture.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const { initializeMainProcessAccountServices } = await import('./main-process-account-services')
    initializeMainProcessAccountServices()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    expect(fixture.state.keybindings?.getOverrides()).toEqual({})
    expect(renderer.keybindings).toEqual({})
    expect(set).not.toHaveBeenCalled()
    const observed: unknown[] = []
    const reconcile = vi.fn(async () => {
      observed.push(fixture.state.keybindings?.getOverrides())
    })
    if (timing === 'after') {
      fixture.state.pluginService = { reconcileActivationState: reconcile }
    }
    complete({
      contents: JSON.stringify({
        version: 1,
        keybindings: { 'plugin:orca-samples.first/run': ['Mod+Shift+T'] }
      }),
      seedCompleted: false
    })
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce())
    const snapshot = fixture.state.keybindings?.getSnapshot()
    expect(snapshot?.overrides).toEqual({ 'plugin:orca-samples.first/run': ['Mod+Shift+T'] })
    expect(fixture.send).toHaveBeenCalledWith('keybindings:changed', snapshot)
    expect(set).toHaveBeenCalledWith({
      keybindings: snapshot?.overrides,
      keybindingSnapshot: snapshot
    })
    if (timing === 'after') {
      expect(reconcile).toHaveBeenCalledOnce()
      expect(observed).toEqual([{ 'plugin:orca-samples.first/run': ['Mod+Shift+T'] }])
    } else {
      // A service constructed later reads the already-hydrated snapshot during its first reconciliation.
      expect(fixture.state.keybindings?.getOverrides()).toEqual({
        'plugin:orca-samples.first/run': ['Mod+Shift+T']
      })
    }
  }
)
