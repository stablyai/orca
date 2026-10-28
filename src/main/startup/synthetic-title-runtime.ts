import { registerPaneKeyTeardownListener, getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'
import { agentHookServer } from '../agent-hooks/server'
import type { AgentStatusState } from '../../shared/agent-status-types'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
} from '../../shared/synthetic-agent-title'
import {
  advanceSyntheticTitleSpinnerEntries,
  getSyntheticTitleSpinnerPaneKeyToStop,
  type SyntheticTitleSpinnerEntry
} from '../synthetic-title-spinner'
import { shouldSendSyntheticTitleFrame } from '../synthetic-title-visibility'
import { shouldCopySyntheticTitleFrameToPtyData } from '../synthetic-title-frame-routing'
import { mainProcessState as state } from './main-process-state'

// Cursor redraws overwrite one-shot OSC titles; reassert at Pi's 80ms cadence and share the animation with OpenCode.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80
const syntheticTitleSpinnerByPaneKey = new Map<
  string,
  SyntheticTitleSpinnerEntry<SyntheticAgentTitleProfile>
>()
let syntheticTitleSpinnerTimer: ReturnType<typeof setInterval> | null = null

function isSyntheticTitleWindowVisible(): boolean {
  const window = state.mainWindow
  return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

function sendSyntheticTitle(
  ptyId: string,
  data: string,
  options: { force?: boolean; semantic?: boolean } = {}
): void {
  // Throttle decorative frames; force final/permission frames because they drive BEL.
  const deliverToWindow = shouldSendSyntheticTitleFrame({
    force: options.force === true,
    windowVisible: isSyntheticTitleWindowVisible()
  })
  // Semantic updates must reach unseen/headless trackers or readiness retains stale ready titles.
  if (!deliverToWindow && options.semantic !== true) {
    return
  }
  // Feed the tracker before checking for windows; fabricated bytes must never enter emulator/tails/transcripts/stats.
  state.runtime?.ingestSyntheticTitleFrame(ptyId, data)
  const window = state.mainWindow
  if (!deliverToWindow || !window || window.isDestroyed()) {
    return
  }
  // Only legacy renderer authority parses these bytes; main authority would mint phantom ACKs (synthetic-title-frame-routing.ts).
  if (shouldCopySyntheticTitleFrameToPtyData(state.store?.getSettings())) {
    window.webContents.send('pty:data', { id: ptyId, data })
  }
}

function canSendDecorativeSyntheticTitle(): boolean {
  return shouldSendSyntheticTitleFrame({
    force: false,
    windowVisible: isSyntheticTitleWindowVisible()
  })
}

export function stopSyntheticTitleSpinner(paneKey: string): void {
  if (syntheticTitleSpinnerByPaneKey.delete(paneKey)) {
    stopSyntheticTitleSpinnerTimerIfIdle()
  }
}

export function stopSyntheticTitleSpinnerTimer(): void {
  if (syntheticTitleSpinnerTimer) {
    clearInterval(syntheticTitleSpinnerTimer)
    syntheticTitleSpinnerTimer = null
  }
}

function stopSyntheticTitleSpinnerTimerIfIdle(): void {
  if (syntheticTitleSpinnerByPaneKey.size === 0) {
    stopSyntheticTitleSpinnerTimer()
  }
}

function tickSyntheticTitleSpinners(): void {
  if (!canSendDecorativeSyntheticTitle()) {
    stopSyntheticTitleSpinnerTimer()
    return
  }
  const ticks = advanceSyntheticTitleSpinnerEntries({
    entries: syntheticTitleSpinnerByPaneKey,
    frameCount: SPINNER_FRAMES.length,
    getPtyIdForPaneKey
  })
  for (const tick of ticks) {
    sendSyntheticTitle(
      tick.ptyId,
      `\x1b]0;${SPINNER_FRAMES[tick.frame]} ${tick.profile.workingLabel}\x07`
    )
  }
  stopSyntheticTitleSpinnerTimerIfIdle()
}

function ensureSyntheticTitleSpinnerTimer(): void {
  if (
    syntheticTitleSpinnerTimer ||
    syntheticTitleSpinnerByPaneKey.size === 0 ||
    !canSendDecorativeSyntheticTitle()
  ) {
    return
  }
  // Share one timer to avoid multiplying idle wakeups per working pane.
  syntheticTitleSpinnerTimer = setInterval(tickSyntheticTitleSpinners, SPINNER_INTERVAL_MS)
}

export function resumeSyntheticTitleSpinnerTimer(): void {
  ensureSyntheticTitleSpinnerTimer()
}

export function driveSyntheticTitleFromHook(
  paneKey: string,
  agentState: AgentStatusState,
  profile: SyntheticAgentTitleProfile
): void {
  const ptyId = getPtyIdForPaneKey(paneKey)
  if (!ptyId) {
    return
  }
  if (agentState === 'working') {
    // Emit immediately so visible startup does not wait for the next 80ms tick.
    const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`, {
      semantic: true
    })
    if (existing) {
      // Refresh profile after mid-pane agent changes so final idle/permission labels stay correct.
      existing.profile = profile
      return
    }
    syntheticTitleSpinnerByPaneKey.set(paneKey, { frame, profile })
    ensureSyntheticTitleSpinnerTimer()
    return
  }
  // Stop before the next tick can restore working; only permission frames ring BEL, completion owns its own notifications.
  stopSyntheticTitleSpinner(paneKey)
  const needsUserInput = agentState === 'blocked' || agentState === 'waiting'
  const label = needsUserInput ? profile.permissionLabel : profile.idleLabel
  sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07${needsUserInput ? '\x07' : ''}`, { force: true })
}

export function initializeSyntheticTitleRuntime(): void {
  // Drop torn-down PTYs explicitly or the shared timer loops forever on no-op sends.
  registerPaneKeyTeardownListener((paneKey) => stopSyntheticTitleSpinner(paneKey))
  // Retire spinners on both pane-status clear and user dismissal; either can otherwise leave finished agents looking active (#13890).
  agentHookServer.subscribePaneStatusClear((clear) => {
    const paneKey = getSyntheticTitleSpinnerPaneKeyToStop(clear)
    if (paneKey) {
      stopSyntheticTitleSpinner(paneKey)
    }
  })
  agentHookServer.subscribeStatusDrop(stopSyntheticTitleSpinner)
  // Process-scope subscription covers headless readiness without any window listener.
  agentHookServer.subscribeEnrichedStatus(driveSyntheticTitleFromHookStatus)
}

export function driveSyntheticTitleFromHookStatus(event: {
  paneKey: string
  payload: { state: AgentStatusState; agentType?: string }
  providerSessionOnly?: boolean
  structuredHost?: unknown
}): void {
  // Identity refreshes have no turn state; structured rows have no PTY title.
  if (event.providerSessionOnly || event.structuredHost) {
    return
  }
  // Inject hook-derived idle/permission frames that native OSC titles can omit.
  const profile = getSyntheticAgentTitleProfile(event.payload.agentType)
  if (
    profile &&
    shouldDriveSyntheticAgentTitleFromHook(event.payload.agentType, event.payload.state)
  ) {
    driveSyntheticTitleFromHook(event.paneKey, event.payload.state, profile)
  }
}
