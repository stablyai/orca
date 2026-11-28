import { app, powerMonitor } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import { BackendSupervisor } from '../backend-desktop/backend-supervisor'
import { provideHostUsageAnalytics } from '../usage/host-usage-analytics'
import { BACKEND_PUBLIC_USAGE_METHOD } from '../../shared/backend/backend-service-contract'
import { AgentAwakeService } from '../power/agent-awake-service'
import { bindAgentAwakeToHookStatus } from '../power/agent-awake-hook-status-binding'
import { normalizeComputerAwakeMode } from '../../shared/app-lifecycle/computer-awake-mode'
import { registerSystemResumeBroadcast } from '../power/system-resume-broadcast'
import { recordWakeSignal } from '../power/wake-signal-clock'
import { installBackgroundRunAwakeHold } from '../power/background-run-awake-hold'
import { holdPowerSaveBlocker } from '../power/power-save-blocker-hold'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import {
  listCapableSharedControlSockets,
  startDesktopPresenceReporter
} from '../notifications/desktop-presence-reporter'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { startWslHostAgentAwake } from '../ipc/wsl/wsl-host-agent-awake-wiring'
import { initTelemetry, track } from '../telemetry/client'
import { setCodexTrustGrantTelemetry } from '../codex/trust/grants/codex-trust-grant-telemetry'
import { initObservability } from '../observability/index'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { reportPreviousHangDetection } from '../hang-watchdog/previous-hang-detection'
import type { NativeHangTelemetry } from '../hang-watchdog/previous-native-hang-telemetry'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { mainProcessState as state } from './main-process-state'
import { runAfterFirstWindowShown } from './main-window/first-window-deferral'

const TELEMETRY_CLIENT_START_FALLBACK_MS = 15_000

function feedWakeSignalClock(): () => void {
  const onResume = (): void => recordWakeSignal('resume')
  const onUnlock = (): void => recordWakeSignal('unlock-screen')
  const onUserActive = (): void => recordWakeSignal('user-did-become-active')
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onUnlock)
  powerMonitor.on('user-did-become-active', onUserActive)
  return () => {
    powerMonitor.off('resume', onResume)
    powerMonitor.off('unlock-screen', onUnlock)
    powerMonitor.off('user-did-become-active', onUserActive)
  }
}

/** Main's power, presence, awake, telemetry and hang observers; core observers start in composition. */
export function initializeMainProcessObservers(store: Store): void {
  state.unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  if (process.platform === 'darwin') {
    state.unsubscribeWakeSignalClock = feedWakeSignalClock()
  }
  // Bots' Tidy-up and Look around hold off idle sleep while they run; display sleep is fine.
  installBackgroundRunAwakeHold(() => holdPowerSaveBlocker('prevent-app-suspension'))
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
  const unsubscribeHookStatus = bindAgentAwakeToHookStatus(agentHookServer, state.agentAwakeService)
  // WSL-host agents never reach the hook server; their host's own stream reports them.
  const stopWslHostAgentAwake = startWslHostAgentAwake(state.agentAwakeService)
  state.unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeHookStatus()
    stopWslHostAgentAwake()
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
        ...(marker.appVersion ? { detected_app_version: marker.appVersion } : {}),
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
}

/** The usage utility process stays a main-owned child; core supplies its worktree history. */
export function startUsageBackend(usageWorktrees: UsageWorktreeHistory): {
  claudeUsage: AutomationUsageClient
  codexUsage: AutomationUsageClient
} {
  const backend = new BackendSupervisor(usageWorktrees)
  state.backend = backend
  // Paired clients get a renderer's usage privileges, never the automation-only methods.
  provideHostUsageAnalytics((call) => backend.callControl(BACKEND_PUBLIC_USAGE_METHOD, call))
  return {
    claudeUsage: backend.automationClient('claudeUsage'),
    codexUsage: backend.automationClient('codexUsage')
  }
}
