// Keep Electron imports out: both desktop and orcad bundle these account services.
import { getClaudeAgentViewService } from '../../claude/agent-view/agent-view-service'
import type { Store } from '../../persistence/loading-store/store'
import { RateLimitService } from '../../rate-limits/service'
import { CodexRuntimeHomeService } from '../../codex-accounts/runtime-home-service'
import { CodexAccountService } from '../../codex-accounts/service'
import { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import { ClaudeAccountService } from '../../claude-accounts/service'
import { getInitialCodexRateLimitTarget } from '../../rate-limits/codex-rate-limit-target'
import { getInitialClaudeRateLimitTarget } from '../../rate-limits/claude-rate-limit-target'
import { getKimiRuntimeTarget, resolveKimiHome } from '../../kimi/kimi-runtime-home'
import { resolveCodexRateLimitHomeUnlessStopped } from '../../rate-limits/codex-rate-limit-wsl-home-gate'
import { inactiveCodexHomeUnlessStopped } from '../../rate-limits/inactive-codex-home'
import { readMiniMaxSessionCookie } from '../../minimax/minimax-cookie-store'
import { readMiniMaxApiKey } from '../../minimax/minimax-api-key-store'
import { readZcodePlanApiKey } from '../../zcode/zcode-plan-api-key-store'
import { readOpenCodeGoApiKey } from '../../opencode/opencode-go-api-key-store'
import { setAntigravityNativeCredentialChangeListener } from '../../antigravity/native-account-host'
import { createAccountRuntimeTargetSettingsSync } from '../../rate-limits/account-runtime-target-sync'
import { normalizeCodexRuntimeSelection } from '../../codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from '../../claude-accounts/runtime-selection'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import { claudeBillingAccountForPaneKey } from '../../claude-accounts/claude-pane-account-registry'
import {
  createClaudeAccountAutoSwitch,
  type ClaudeAutoSwitched
} from '../../claude-accounts/claude-account-auto-switch'
import { resolveClaudeAccountHome } from '../../claude-accounts/claude-account-home-attribution'

export type ProviderAccountServices = {
  rateLimits: RateLimitService
  codexRuntimeHome: CodexRuntimeHomeService
  codexAccounts: CodexAccountService
  claudeRuntimeAuth: ClaudeRuntimeAuthService
  claudeAccounts: ClaudeAccountService
}

export function createProviderAccountServices(
  store: Store,
  options: {
    codexAccountLifecycle?: ConstructorParameters<typeof CodexAccountService>[3]
    setClaudeStatusLineListener: (listener: (event: ClaudeStatusLineRateLimits) => void) => void
    onClaudeAutoSwitched?: (switched: ClaudeAutoSwitched) => void
  }
): ProviderAccountServices {
  const agentView = getClaudeAgentViewService()
  void agentView.reconcile(store.getSettings())
  const rateLimits = new RateLimitService()
  const codexRuntimeHome = new CodexRuntimeHomeService(store)
  const codexAccounts = new CodexAccountService(
    store,
    rateLimits,
    codexRuntimeHome,
    options.codexAccountLifecycle
  )
  const claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  const claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.onStateChange(
    createClaudeAccountAutoSwitch({
      getSettings: () => store.getSettings(),
      rateLimits,
      accounts: claudeAccounts,
      onSwitched: (switched) => options.onClaudeAutoSwitched?.(switched)
    })
  )
  // Background quota polls must not boot stopped distros; user-driven resets may prepare them.
  rateLimits.setCodexHomePathResolver((target) =>
    resolveCodexRateLimitHomeUnlessStopped(codexRuntimeHome, target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Read credentials where Kimi’s CLI refreshes its token, including WSL (#12370).
  rateLimits.setKimiHomeResolver(() => resolveKimiHome(getKimiRuntimeTarget(store.getSettings())))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    void agentView.reconcile(settings)
    // Auto runtime selection remains live as provider settings change.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
    if ('opencodeSessionCookie' in updates || 'opencodeWorkspaceId' in updates) {
      rateLimits.invalidateOpenCodeGoCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh OpenCode Go usage after a settings change:',
          error
        )
      })
    }
    // Clear quota data from the old MiniMax endpoint/group before the next poll.
    if (
      'minimaxEndpoint' in updates ||
      'minimaxGroupId' in updates ||
      'minimaxUsageModels' in updates
    ) {
      rateLimits.invalidateMiniMaxCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh MiniMax usage after a settings change:',
          error
        )
      })
    }
    // Clear quota data from the old GLM Coding Plan site before the next poll.
    if ('zcodePlanSite' in updates) {
      rateLimits.invalidateZcodeCredentialState()
      void rateLimits.refresh().catch((error: unknown) => {
        console.warn(
          '[rate-limits] Failed to refresh GLM Coding Plan usage after a settings change:',
          error
        )
      })
    }
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth.prepareForRateLimitFetch(target)
  )
  // Live statusLine usage avoids OAuth endpoint polling and its 429s.
  options.setClaudeStatusLineListener((event) => {
    const billingAccountId = event.paneKey ? claudeBillingAccountForPaneKey(event.paneKey) : null
    rateLimits.ingestLiveClaudeRateLimits(billingAccountId ? { ...event, billingAccountId } : event)
  })
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  }, readOpenCodeGoApiKey)
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store.getSettings()
    const apiKey = readMiniMaxApiKey() ?? ''
    return {
      sessionCookie: apiKey ? '' : (readMiniMaxSessionCookie() ?? ''),
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels,
      endpoint: settings.minimaxEndpoint,
      apiKey
    }
  })
  rateLimits.setZcodePlanConfigResolver(() => ({
    site: store.getSettings().zcodePlanSite ?? 'zai',
    apiKey: readZcodePlanApiKey() ?? ''
  }))
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store.getSettings().geminiCliOAuthEnabled)
  // Reuse the meter switch so hidden Antigravity usage does not spawn agy.
  rateLimits.setAntigravityUsageEnabledResolver(() =>
    store.getUI().statusBarItems.includes('antigravity')
  )
  setAntigravityNativeCredentialChangeListener(() =>
    rateLimits.invalidateAntigravityCredentialState()
  )
  rateLimits.setNetworkProxySettingsResolver(() => store.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  // The selected host account stays out of the inactive cache so a live statusline still lands on state.claude.
  rateLimits.setActiveClaudeUsageAccountResolver(() => {
    const settings = store.getSettings()
    const id = normalizeClaudeRuntimeSelection(settings).host
    if (!id) {
      return null
    }
    const account = settings.claudeManagedAccounts.find((entry) => entry.id === id)
    if (!account || account.managedAuthRuntime === 'wsl') {
      return null
    }
    const runsOnSystemDefault = claudeRuntimeAuth.router.coveredBySystemDefault(account.id)
    return {
      id: account.id,
      managedAuthRuntime: account.managedAuthRuntime,
      wslDistro: account.wslDistro,
      wslLinuxAuthPath: account.wslLinuxAuthPath,
      ...(runsOnSystemDefault ? { runsOnSystemDefault: true as const } : {})
    }
  })
  // Why: a statusline post names its CLAUDE_CONFIG_DIR; only the account layer knows whose folder that is.
  rateLimits.setLiveClaudeAccountResolver((configDir) =>
    resolveClaudeAccountHome(configDir, store.getSettings().claudeManagedAccounts, (id) =>
      claudeRuntimeAuth.router.accountHome(id)
    )
  )
  rateLimits.setClaudeSystemDefaultCoverageResolver((accountId) =>
    claudeRuntimeAuth.router.coveredBySystemDefault(accountId)
  )
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () =>
          inactiveCodexHomeUnlessStopped(
            codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
          )
      }))
  })
  return { rateLimits, codexRuntimeHome, codexAccounts, claudeRuntimeAuth, claudeAccounts }
}
