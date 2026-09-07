import { app } from 'electron'
import { join } from 'node:path'
import { AgentAwakeService } from '../agent-awake-service'
import { normalizeComputerAwakeMode } from '../../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from '../system-resume-broadcast'
import { agentHookServer, type AgentHookProviderSessionIdentity } from '../agent-hooks/server'
import { createHookProviderSessionInvalidator } from '../agent-hooks/hook-provider-session-invalidation'
import { createHookStatusSessionTabsInvalidator } from '../agent-hooks/hook-status-session-tabs-invalidation'
import { initTelemetry, track } from '../telemetry/client'
import { setCodexTrustGrantTelemetry } from '../codex/codex-trust-grant-telemetry'
import { initObservability } from '../observability'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { recoverPendingSkillTransactions } from '../skills/skill-transaction-startup-recovery'
import { initCohortClassifier } from '../telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from '../telemetry/onboarding-cohort-classifier'
import { StatsCollector } from '../stats/collector'
import { AgentSessionTransitionRecorder } from '../stats/agent-session-transition-recorder'
import { ClaudeUsageStore } from '../claude-usage/store'
import { CodexUsageStore } from '../codex-usage/store'
import { OpenCodeUsageStore } from '../opencode-usage/store'
import { installRepoMaintenanceIdleGate } from '../repo-maintenance-idle-gate'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessObservers(): void {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before observers')
  }
  state.unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  state.agentAwakeService = new AgentAwakeService()
  state.agentAwakeService.setMode(
    normalizeComputerAwakeMode(
      store.getSettings().computerAwakeMode,
      store.getSettings().keepComputerAwakeWhileAgentsRun
    )
  )
  // Why: start from empty — disk-hydrated status rows are UI continuity only; only this runtime's hook events keep the computer awake.
  state.agentAwakeService.setStatuses([])
  state.uninstallRepoMaintenanceIdleGate = installRepoMaintenanceIdleGate({
    isQuitting: () => state.isQuitting,
    getWorkingAgentCount: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0
  })
  const collectChangedProviderSessionWorktrees = createHookProviderSessionInvalidator()
  const publishProviderSessionChanges = (identities: AgentHookProviderSessionIdentity[]): void => {
    const ownedIdentities = identities.map((identity) => ({
      ...identity,
      worktreeId:
        identity.worktreeId ??
        state.runtime?.getTerminalWorktreeIdForPaneKey(identity.paneKey) ??
        undefined
    }))
    for (const worktreeId of collectChangedProviderSessionWorktrees(ownedIdentities)) {
      // Why not `notifyMobileSessionTabsChanged` alone: it re-emits at the unchanged
      // `snapshotVersion`, which every client drops on its monotonic gate.
      state.runtime?.touchMobileSessionTabsForWorktree(worktreeId, { immediate: true })
    }
  }
  state.publishProviderSessionChanges = publishProviderSessionChanges
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    state.agentAwakeService?.setStatuses(statuses)
  })
  // Healthy session.tabs streams need a push when transcript identity changes.
  const unsubscribeProviderSessionChanges = agentHookServer.subscribeProviderSessionChanges(
    (sessions) => publishProviderSessionChanges(sessions)
  )
  // Why: hook rows are the only carrier of live agent state on a headless host, and
  // nothing else republishes `session.tabs` when one changes — so a paired client
  // would keep the pane's last projection until an unrelated PTY touch came along.
  const hookStatusChangedSessionTabs = createHookStatusSessionTabsInvalidator()
  const unsubscribeHookStatusSessionTabs = agentHookServer.subscribeEnrichedStatus((enriched) => {
    if (hookStatusChangedSessionTabs(enriched)) {
      state.runtime?.touchMobileSessionTabsForPane(enriched.paneKey, enriched.worktreeId ?? null)
    }
  })
  // Teardown: agent exit, pane close, and the SSH transient-disconnect batch all land
  // here. Without it the live state published above becomes a zombie question card.
  const unsubscribeHookStatusClear = agentHookServer.subscribePaneStatusClear((clear) => {
    const clearedPaneKeys =
      'paneKey' in clear
        ? [clear.paneKey]
        : hookStatusChangedSessionTabs.forgetConnection(clear.connectionId)
    for (const paneKey of clearedPaneKeys) {
      hookStatusChangedSessionTabs.forgetPane(paneKey)
      state.runtime?.touchMobileSessionTabsForPane(paneKey)
    }
  })
  state.unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeStatusChanges()
    unsubscribeProviderSessionChanges()
    unsubscribeHookStatusSessionTabs()
    unsubscribeHookStatusClear()
  }
  // Why: telemetry must init before any IPC handler/renderer can call track(); it's a no-op in dev and while TELEMETRY_ENABLED is false, so it's safe early.
  initTelemetry(store)
  // Why: the breadcrumb alone never leaves the machine — it rides crash reports, and a hang is not
  // a crash (the app is force-quit, so no report is ever generated). Without this the incidence
  // number the watchdog exists to produce would sit unread on the user's disk. Must run after
  // initTelemetry: track() drops silently until the client and store are wired.
  if (state.hangDetection) {
    track('main_thread_hang_detected', {
      unresponsive_ms: Math.round(state.hangDetection.unresponsiveMs),
      self_recovered: state.hangDetection.selfRecovered
    })
  }
  // Why: the trust-grant module is bundled into plain-node CLI entries where
  // the telemetry client cannot load, so the tracker is injected here instead
  // of imported there.
  setCodexTrustGrantTelemetry(({ outcome, hostKind, lane, reason, errorClass, verifyClass }) => {
    track('codex_trust_grant', {
      outcome,
      host_kind: hostKind,
      lane,
      ...(reason !== undefined ? { fallback_reason: reason } : {}),
      ...(errorClass !== undefined ? { error_class: errorClass } : {}),
      ...(verifyClass !== undefined ? { verify_class: verifyClass } : {})
    })
  })
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  state.skillTransactionRecovery = recoverPendingSkillTransactions(
    join(app.getPath('userData'), 'skill-installs')
  )
  void state.skillTransactionRecovery
    .then((report) => {
      const result = report as {
        scanned: number
        recovered: number
        failures: { code: string }[]
        truncated: boolean
      }
      if (result.scanned || result.failures.length || result.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: result.scanned,
          recovered: result.recovered,
          failures: result.failures.map((failure) => failure.code),
          truncated: result.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  // Why: cohort-classifier reads repo count synchronously at every emit, so hydrate it here — before any IPC handler or window can trigger track().
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  state.stats = new StatsCollector()
  // Agent-session stats come from hook status transitions, the same truth the
  // sidebar and dashboard read — never from OSC terminal titles, which miss
  // hook-only agents and count any spinner TUI as an agent (#10201).
  const agentSessionRecorder = new AgentSessionTransitionRecorder(state.stats)
  agentHookServer.subscribeEnrichedStatus((enriched) => agentSessionRecorder.onStatus(enriched))
  agentHookServer.subscribePaneStatusClear((clear) => agentSessionRecorder.onCleared(clear))
  state.claudeUsage = new ClaudeUsageStore(store)
  state.codexUsage = new CodexUsageStore(store)
  state.openCodeUsage = new OpenCodeUsageStore(store)
}
