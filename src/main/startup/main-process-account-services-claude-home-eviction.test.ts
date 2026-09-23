import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notifyClaudeHomeBindingChanged,
  setClaudeHomeBindingChangeNotifier
} from '../rate-limits/claude-home-binding-change-notification'
import { initializeMainProcessAccountServices } from './main-process-account-services'
import { mainProcessState as state } from './main-process-state'

/**
 * Why this file exists: `main-process-account-services.ts` is the *only* place that connects the
 * binding-change seam to the rate-limit service, it is imported by one non-test file, and the
 * eviction tests elsewhere install a notifier by hand. Deleting or reordering that one line — in a
 * startup refactor, or resolving a merge — leaves `pnpm test`, `pnpm tc` and `pnpm lint` green while
 * restoring the defect round 2 filed as R2: the notifier stays null, the `?.` swallows the call, and
 * every bound row keeps rendering the previous directory's bars under the group's name.
 *
 * Everything but the seam is mocked, so the assertion is about the wiring and nothing else.
 */

const evictBoundClaudeHomeUsage = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-test-home' } }))

vi.mock('../rate-limits/service', () => ({
  RateLimitService: class {
    evictBoundClaudeHomeUsage = evictBoundClaudeHomeUsage
    ingestLiveClaudeRateLimits = vi.fn()
    invalidateMiniMaxCredentialState = vi.fn()
    refresh = vi.fn(async () => {})
    setBoundClaudeHomesResolver = vi.fn()
    setClaudeAuthPreparationResolver = vi.fn()
    setClaudeFetchTarget = vi.fn()
    setCodexFetchTarget = vi.fn()
    setCodexHomePathResolver = vi.fn()
    setGeminiCliOAuthEnabledResolver = vi.fn()
    setInactiveClaudeAccountsResolver = vi.fn()
    setInactiveCodexAccountsResolver = vi.fn()
    setKimiHomeResolver = vi.fn()
    setMiniMaxConfigResolver = vi.fn()
    setNetworkProxySettingsResolver = vi.fn()
    setOpenCodeGoConfigResolver = vi.fn()
  }
}))

vi.mock('../codex-accounts/runtime-home-service', () => ({
  CodexRuntimeHomeService: class {
    isHostSystemDefaultRealHome = vi.fn(() => false)
    isHostSystemDefaultSessionMigrationEligible = vi.fn(() => false)
    setRealHomeLaneGate = vi.fn()
  }
}))
vi.mock('../codex-accounts/service', () => ({ CodexAccountService: class {} }))
vi.mock('../claude-accounts/runtime-auth-service', () => ({ ClaudeRuntimeAuthService: class {} }))
vi.mock('../claude-accounts/service', () => ({ ClaudeAccountService: class {} }))
vi.mock('../keybindings/keybinding-service', () => ({
  KeybindingService: class {
    getOverrides = vi.fn(() => ({}))
  }
}))
vi.mock('../codex/codex-session-migration-scheduler', () => ({
  createCodexSessionMigrationScheduler: () => ({
    requestRun: vi.fn(),
    scheduleInitialRun: vi.fn()
  })
}))
vi.mock('../codex/codex-session-backfill', () => ({
  startCodexSessionBackfillInBackground: vi.fn()
}))
vi.mock('../codex/codex-session-index-heal', () => ({
  startCodexSessionIndexHealInBackground: vi.fn()
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(async () => {})
}))
vi.mock('../codex/codex-home-paths', () => ({ getOrcaManagedCodexHomePath: () => '/tmp/codex' }))
vi.mock('../codex/hook-service', () => ({ setSystemCodexHomeHookSweepSuppressed: vi.fn() }))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  isRealHomeCodexHookLaneUsable: () => false
}))
vi.mock('../codex/codex-session-source-home', () => ({
  resolveHostCodexSessionSourceHome: () => undefined
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => false
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { setClaudeStatusLineListener: vi.fn() }
}))
vi.mock('../browser/browser-manager', () => ({
  browserManager: { setSettingsResolver: vi.fn() }
}))
vi.mock('../rate-limits/codex-rate-limit-target', () => ({
  getInitialCodexRateLimitTarget: () => undefined
}))
vi.mock('../rate-limits/claude-rate-limit-target', () => ({
  getInitialClaudeRateLimitTarget: () => undefined
}))
vi.mock('../rate-limits/account-runtime-target-sync', () => ({
  createAccountRuntimeTargetSettingsSync: () => vi.fn(async () => {})
}))
vi.mock('../rate-limits/bound-claude-home-bindings', () => ({
  resolveLocalBoundClaudeHomes: () => []
}))
vi.mock('../kimi/kimi-runtime-home', () => ({
  getKimiRuntimeTarget: () => undefined,
  resolveKimiHome: () => undefined
}))
vi.mock('../minimax/minimax-cookie-store', () => ({ readMiniMaxSessionCookie: () => '' }))
vi.mock('../minimax/minimax-api-key-store', () => ({ readMiniMaxApiKey: () => '' }))

function stubStore(): void {
  const settings = {
    claudeManagedAccounts: [],
    codexManagedAccounts: [],
    keybindings: {},
    tabSwitchKeybindingSeed: 'done'
  }
  // Why a loosely-typed alias rather than a cast: the init path reads only these four members, and
  // every collaborator that would read more of them is mocked above — so a real `Store` would be a
  // hundred lines of stub for one assertion about one line of wiring.
  const mutable: Record<string, unknown> = state
  mutable.store = {
    getSettings: () => settings,
    getProjectGroups: () => [],
    onSettingsChanged: vi.fn(),
    updateSettings: vi.fn()
  }
  mutable.claudeUsage = {}
  mutable.codexUsage = {}
  mutable.openCodeUsage = {}
}

describe('main-process account services', () => {
  beforeEach(() => {
    evictBoundClaudeHomeUsage.mockClear()
    setClaudeHomeBindingChangeNotifier(() => {
      throw new Error('startup did not install the binding-change notifier')
    })
    stubStore()
  })

  it('installs a binding-change notifier that reaches the rate-limit service', () => {
    initializeMainProcessAccountServices()

    notifyClaudeHomeBindingChanged('group-a')

    expect(evictBoundClaudeHomeUsage).toHaveBeenCalledWith('group-a')
  })
})
