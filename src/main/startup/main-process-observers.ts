import { BackendSupervisor } from '../backend-desktop/backend-supervisor'
import { app, powerMonitor } from 'electron'
import { join } from 'node:path'
import { AgentAwakeService } from '../power/agent-awake-service'
import { normalizeComputerAwakeMode } from '../../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from '../power/system-resume-broadcast'
import { registerWakeSignalClock } from '../power/wake-signal-clock'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import {
  listCapableSharedControlSockets,
  startDesktopPresenceReporter
} from '../notifications/desktop-presence-reporter'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/runtime/hook-status-session-tabs-republish'
import { initTelemetry, track } from '../telemetry/client'
import { setCodexTrustGrantTelemetry } from '../codex/trust/grants/codex-trust-grant-telemetry'
import { initObservability } from '../observability/index'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { reportPreviousHangDetection } from '../hang-watchdog/previous-hang-detection'
import type { NativeHangTelemetry } from '../hang-watchdog/previous-native-hang-telemetry'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { recoverPendingSkillTransactions } from '../skills/transaction-state/skill-transaction-startup-recovery'
import { initCohortClassifier } from '../telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from '../telemetry/onboarding-cohort-classifier'
import { StatsCollector } from '../stats/collector'
import { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import { feedAgentSessionStats } from '../stats/agent-session-stats-feed'
import { installRepoMaintenanceIdleGate } from '../workspaces/catalog/repo-maintenance-idle-gate'
import { mainProcessState as state } from './main-process-state'
import { runAfterFirstWindowShown } from './main-window/first-window-deferral'

const TELEMETRY_CLIENT_START_FALLBACK_MS = 15_000

export function initializeMainProcessObservers(): void {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before observers')
  }
  state.unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  if (process.platform === 'darwin') {
    state.unsubscribeWakeSignalClock = registerWakeSignalClock()
  }
  state.stopDesktopPresenceReporter = startDesktopPresenceReporter({
    readAway: () => readDesktopAwayState(powerMonitor),
    listTargets: listCapableSharedControlSockets,
    subscribePowerEvents: ({ away, back }) => {
      powerMonitor.on('suspend', away)
      powerMonitor.on('lock-screen', away)
      powerMonitor.on('resume', back)
      powerMonitor.on('unlock-screen', back)
      return () => {
        powerMonitor.off('suspend', away)
        powerMonitor.off('lock-screen', away)
        powerMonitor.off('resume', back)
        powerMonitor.off('unlock-screen', back)
      }
    }
  })
  state.agentAwakeService = new AgentAwakeService()
  state.agentAwakeService.setMode(
    normalizeComputerAwakeMode(
      store.getSettings().computerAwakeMode,
      store.getSettings().keepComputerAwakeWhileAgentsRun
    )
  )
  // Hydrated rows preserve UI only; only this runtime's live hook events may keep the machine awake.
  state.agentAwakeService.setStatuses([])
  state.uninstallRepoMaintenanceIdleGate = installRepoMaintenanceIdleGate({
    isQuitting: () => state.isQuitting,
    getWorkingAgentCount: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0
  })
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    state.agentAwakeService?.setStatuses(statuses)
  })
  const unsubscribeStatusFreshness = agentHookServer.subscribeStatusFreshness((status) => {
    state.agentAwakeService?.observeStatusFreshness(status)
  })
  const uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => state.runtime
  )
  state.unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeStatusChanges()
    unsubscribeStatusFreshness()
    uninstallHookStatusRepublish()
  }
  // Initialize before IPC/renderers can track; the telemetry client gates dev/disabled cases itself.
  // Load the SDK after first paint (#35752); headless serve and GPU failures never show a window.
  initTelemetry(store, (start) =>
    runAfterFirstWindowShown(start, TELEMETRY_CLIENT_START_FALLBACK_MS)
  )
  const profileStateStartup = state.profileStateStartup
  if (profileStateStartup) {
    track('profile_state_authority_selected', {
      backend: profileStateStartup.backend,
      classification: profileStateStartup.classification,
      authority_mode: 'sqlite-established',
      runtime: profileStateStartup.runtime,
      migrated: profileStateStartup.migrated
    })
  }
  // Inject tracking because plain-Node CLI imports cannot load the telemetry client.
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
  // Initialize the independent error-tracking sink before any IPC/runtime span; it enforces diagnostics/privacy gates internally.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  state.hangDetection = reportPreviousHangDetection(getCanonicalUserDataPath())
  if (state.hangDetection) {
    const marker = state.hangDetection
    const report = (details: NativeHangTelemetry): void => {
      track('main_thread_hang_detected', {
        unresponsive_ms: Math.round(marker.unresponsiveMs),
        self_recovered: marker.selfRecovered,
        ...details
      })
    }
    if (process.platform === 'darwin') {
      void import('../hang-watchdog/previous-native-hang-telemetry')
        .then(({ readPreviousNativeHangTelemetry }) =>
          readPreviousNativeHangTelemetry(getCanonicalUserDataPath(), marker)
        )
        .then(report, () => report({}))
    } else {
      report({})
    }
  }
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
  // Hydrate repo count before IPC/window tracking; cohort classification reads it synchronously.
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  state.stats = new StatsCollector()
  feedAgentSessionStats(state.stats, agentHookServer)
  const usageWorktrees = new UsageWorktreeHistory(
    store,
    join(getCanonicalUserDataPath(), 'orca-usage-worktree-history.json')
  )
  state.usageWorktreeHistory = usageWorktrees
  state.backend = new BackendSupervisor(usageWorktrees)
  state.claudeUsage = state.backend.automationClient('claudeUsage')
  state.codexUsage = state.backend.automationClient('codexUsage')
}
