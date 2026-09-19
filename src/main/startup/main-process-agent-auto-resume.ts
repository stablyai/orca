import { AgentAutoResumeService } from '../agent-auto-resume-service'
import { deliverAgentAutoResumeNotification } from '../agent-auto-resume-notifications'
import {
  AGENT_AUTO_RESUME_UPDATE_CHANNEL,
  type UsageLimitProvider
} from '../../shared/agent-auto-resume-types'
import { getEffectiveAgentHibernationIdleMs } from '../../shared/agent-hibernation-idle'
import { chooseUsageLimitReset } from '../runtime/agent-pane-delivery'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RateLimitService } from '../rate-limits/service'
import { mainProcessState as state } from './main-process-state'
import { focusWorktreeFromMain } from './main-window-actions'

// Ceiling on how long the rate-limit watcher waits before selecting the
// wait-for-reset row in a parked usage-limit chooser (see getMenuGraceMs).
const AGENT_AUTO_RESUME_MENU_GRACE_CAP_MS = 10 * 60 * 1000

function getProviderResetAt(
  rateLimitService: RateLimitService | null,
  provider: UsageLimitProvider | null
): number | null {
  if (!rateLimitService || !provider) {
    return null
  }
  const rateLimitState = rateLimitService.getState()
  const windows = provider === 'claude' ? rateLimitState.claude : rateLimitState.codex
  // The 5-hour session window is the one that stalls active agents; fall back
  // to the weekly window when the session window carries no reset.
  return windows?.session?.resetsAt ?? windows?.weekly?.resetsAt ?? null
}

export function initializeMainProcessAgentAutoResume(
  runtimeService: OrcaRuntimeService
): AgentAutoResumeService {
  const activeStore = state.store
  if (!activeStore) {
    throw new Error('Store must be initialized before the agent auto-resume service')
  }
  const rateLimitService = state.rateLimits
  const service = new AgentAutoResumeService({
    verifyStall: (ptyId) => runtimeService.getUsageLimitStallSnapshot(ptyId),
    sendKeys: async (handle, action) => {
      await runtimeService.sendTerminal(handle, action)
    },
    chooseMenuReset: (ptyId, handle, menuText) =>
      chooseUsageLimitReset(runtimeService, ptyId, handle, menuText),
    // The paneKey carries the tab id the "Rate limit watcher" checkbox wrote.
    isWatchEnabled: (paneKey) => {
      const tabId = paneKey === null ? undefined : parsePaneKey(paneKey)?.tabId
      return tabId !== undefined && activeStore.isRateLimitWatcherEnabled(tabId)
    },
    // The wait-for-reset menu grace follows the user's configured agent idle
    // timeout so a human gets a window to intervene, but capped at 10 minutes:
    // the 30-minute default left rate-limited agents parked for half an hour
    // doing nothing (owner call, 2026-08-27). A configured timeout shorter
    // than the cap still wins.
    getMenuGraceMs: () =>
      Math.min(
        AGENT_AUTO_RESUME_MENU_GRACE_CAP_MS,
        getEffectiveAgentHibernationIdleMs(activeStore.getSettings().agentHibernationIdleMs)
      ),
    getProviderResetAt: (provider) => getProviderResetAt(rateLimitService, provider),
    notify: (notification) =>
      deliverAgentAutoResumeNotification(notification, {
        getNotificationSettings: () => activeStore.getSettings().notifications,
        focus: (worktreeId) => focusWorktreeFromMain(worktreeId)
      }),
    onSnapshot: (snapshot) =>
      state.mainWindow?.webContents.send(AGENT_AUTO_RESUME_UPDATE_CHANNEL, snapshot)
  })
  state.unsubscribeUsageLimitStall = runtimeService.subscribeUsageLimitStall((event) =>
    service.handleEvent(event)
  )
  state.agentAutoResumeService = service
  return service
}
