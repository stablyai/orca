import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fixture = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  onSettingsChanged: vi.fn<(listener: (updates: Partial<GlobalSettings>) => void) => void>(),
  prewarm: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/home/test' } }))
vi.mock('../keybindings/keybinding-service', () => ({ KeybindingService: class {} }))
vi.mock('../providers/accounts/provider-account-services', () => ({
  createProviderAccountServices: () => ({})
}))
vi.mock('../codex/history/backfill/codex-session-migration-scheduler', () => ({
  createCodexSessionMigrationScheduler: () => ({ scheduleInitialRun: vi.fn() })
}))
vi.mock('../codex/history/backfill/codex-session-backfill', () => ({
  startCodexSessionBackfillInBackground: vi.fn()
}))
vi.mock('../codex/history/index/codex-session-index-heal', () => ({
  startCodexSessionIndexHealInBackground: vi.fn()
}))
vi.mock('../codex/history/index/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))
vi.mock('../codex/configuration/homes/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => '/home/test'
}))
vi.mock('../opencode/opencode-go-api-key-store', () => ({
  hasOpenCodeGoApiKey: vi.fn(),
  readOpenCodeGoApiKey: vi.fn(),
  saveOpenCodeGoApiKey: vi.fn()
}))
vi.mock('../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: {} }))
vi.mock('../codex/history/rollouts/codex-session-source-home', () => ({
  resolveHostCodexSessionSourceHome: vi.fn()
}))
vi.mock('../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { setSettingsResolver: vi.fn() }
}))
vi.mock('../runtime/agent-session/model-catalog/structured-agent-model-catalog-wiring', () => ({
  prewarmStructuredAgentModelCatalogs: fixture.prewarm
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    store: {
      getSettings: () => ({}),
      onSettingsChanged: fixture.onSettingsChanged,
      migrateLegacyOpenCodeGoApiKey: vi.fn()
    },
    claudeUsage: { refresh: fixture.refresh },
    codexUsage: {},
    openCodeUsage: {},
    museUsage: {}
  }
}))

import { initializeMainProcessAccountServices } from './main-process-account-services'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Claude usage account startup wiring', () => {
  it.each([
    'localAccountRuntime',
    'localAccountWslDistro',
    'localWindowsRuntimeDefault',
    'activeClaudeManagedAccountId',
    'activeClaudeManagedAccountIdsByRuntime',
    'claudeManagedAccounts'
  ])('queues a selected-profile rescan after %s changes', (key) => {
    initializeMainProcessAccountServices()
    const listener = fixture.onSettingsChanged.mock.calls[0]![0]

    listener({ [key]: undefined })

    expect(fixture.refresh).toHaveBeenCalledWith(true, { rerunIfScanning: true })
  })

  it('keeps model prewarming without rescanning Claude for another provider', () => {
    initializeMainProcessAccountServices()
    const listener = fixture.onSettingsChanged.mock.calls[0]![0]

    listener({ activeCodexManagedAccountId: null })

    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.prewarm).toHaveBeenCalled()
  })
})
