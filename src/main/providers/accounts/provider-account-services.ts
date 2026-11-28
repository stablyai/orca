// Keep Electron imports out: both desktop and orcad bundle these account services.
import { getClaudeAgentViewService } from '../../claude/agent-view/agent-view-service'
import type { Store } from '../../persistence/loading-store/store'
import { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import { CodexRuntimeHomeService } from '../../codex-accounts/runtime-home-service'
import { CodexAccountService } from '../../codex-accounts/service'
import { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import { ClaudeAccountService } from '../../claude-accounts/service'
import { getInitialCodexRateLimitTarget } from '../../rate-limits/providers/codex/codex-rate-limit-target'
import { getInitialClaudeRateLimitTarget } from '../../rate-limits/providers/claude/claude-rate-limit-target'
import { resolveKimiHome } from '../../kimi/kimi-runtime-home'
import { resolveLocalAccountUsageTarget } from '../../../shared/agent-accounts/local-account-runtime'
import { resolveCodexRateLimitHomeUnlessStopped } from '../../rate-limits/providers/codex/codex-rate-limit-wsl-home-gate'
import { readMiniMaxSessionCookie } from '../../minimax/minimax-cookie-store'
import { readMiniMaxApiKey } from '../../minimax/minimax-api-key-store'
import { readZcodePlanApiKey } from '../../zcode/zcode-plan-api-key-store'
import { readOpenCodeGoApiKey } from '../../opencode/accounts/opencode-go-api-key-store'
import { createAccountRuntimeTargetSettingsSync } from '../../rate-limits/service/account-runtime-target-sync'
import { resolveInactiveCodexAccounts } from '../../rate-limits/inactive-codex-accounts'
import { normalizeClaudeRuntimeSelection } from '../../claude-accounts/selection/runtime-selection'
import { HOST_SYSTEM_DEFAULT_USAGE_IDS } from '../../../shared/agent-accounts/host-system-default-usage'
import type { ClaudeStatusLineRateLimits } from '../../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { releaseIdleChatsOnOtherAccount } from '../../native-chat/agent-session-wire/host/structured-agent-session-account-switch'
import { AGY_HOST_SELECTION } from '../../antigravity/agy-account-selection'
import {
  moveChatsToSelectedAccount,
  noteChatNotMovedToAccount
} from '../../native-chat/agent-session-wire/host/structured-agent-session-saved-account-switch'

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
  // Chats' agents (a bot's too) keep the account they launched with: idle ones restart on the new one.
  claudeAccounts.onSelectionApplied((committed) => {
    void releaseIdleChatsOnOtherAccount(getStructuredAgentSessionHost(), 'claude', committed)
  })
  // agy's saved accounts swap its one login, which a chat's running agy keeps: same as above, and
  // a chat still running a turn on the previous account says so.
  AGY_HOST_SELECTION.onChanged((committed) => {
    void moveChatsToSelectedAccount(
      getStructuredAgentSessionHost(),
      'antigravity',
      AGY_HOST_SELECTION,
      committed
    )
  })
  AGY_HOST_SELECTION.onChatNotMoved(
    (chat) =>
      void noteChatNotMovedToAccount(getStructuredAgentSessionHost(), {
        ...chat,
        to: AGY_HOST_SELECTION.email(chat.to) ?? 'the selected account'
      })
  )
  // Background quota polls must not boot stopped distros; user-driven resets may prepare them.
  rateLimits.setCodexHomePathResolver((target) =>
    resolveCodexRateLimitHomeUnlessStopped(codexRuntimeHome, target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Read credentials where Kimi’s CLI refreshes its token, including WSL (#12370).
  rateLimits.setKimiHomeResolver(() =>
    resolveKimiHome(resolveLocalAccountUsageTarget(store.getSettings()))
  )
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    void agentView.reconcile(settings)
    if (updates.claudeOAuthUsageEnabled === false) {
      rateLimits.discardClaudeOAuthUsage()
    } else if (updates.claudeOAuthUsageEnabled === true) {
      void rateLimits
        .getState()
        .then((state) => rateLimits.refreshClaudeForTarget(state.claudeTarget))
        .catch((error: unknown) => {
          console.warn(
            '[rate-limits] Failed to refresh Claude usage after enabling polling:',
            error
          )
        })
    }
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
    rateLimits.ingestLiveClaudeRateLimits(event)
  })
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  }, readOpenCodeGoApiKey)
  rateLimits.setMiniMaxConfigResolver(async () => {
    const settings = store.getSettings()
    const apiKey = (await readMiniMaxApiKey()) ?? ''
    return {
      sessionCookie: apiKey ? '' : ((await readMiniMaxSessionCookie()) ?? ''),
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels,
      endpoint: settings.minimaxEndpoint,
      apiKey
    }
  })
  rateLimits.setZcodePlanConfigResolver(async () => ({
    site: store.getSettings().zcodePlanSite ?? 'zai',
    apiKey: (await readZcodePlanApiKey()) ?? ''
  }))
  rateLimits.setClaudeOAuthUsageEnabledResolver(() => store.getSettings().claudeOAuthUsageEnabled)
  // Hidden Muse meters must not spawn the Muse CLI.
  rateLimits.setMuseUsageEnabledResolver(() => store.getUI().statusBarItems.includes('muse'))
  rateLimits.setNetworkProxySettingsResolver(() => store.getSettings())
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const selection = normalizeClaudeRuntimeSelection(settings)
    const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
    const inactive = settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
    // System default has no saved id, so it is read under its own key while a saved host account is selected.
    return selection.host ? [...inactive, { id: HOST_SYSTEM_DEFAULT_USAGE_IDS.claude }] : inactive
  })
  rateLimits.setInactiveCodexAccountsResolver(() =>
    resolveInactiveCodexAccounts(store.getSettings(), (account) =>
      codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
    )
  )
  // Every host runs the poll timer; ticks fetch only while a window or remote reader watches.
  rateLimits.start({ fetchImmediately: false })
  return { rateLimits, codexRuntimeHome, codexAccounts, claudeRuntimeAuth, claudeAccounts }
}
