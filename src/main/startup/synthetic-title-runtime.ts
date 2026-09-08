import { registerPaneKeyTeardownListener, getPtyIdForPaneKey } from '../ipc/pty'
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
import { resolveTuiAgentPermissionMode } from '../../shared/tui-agent-permissions'
import { mainProcessState as state } from './main-process-state'

// Why: cursor-agent re-emits its own OSC title on every redraw, overwriting a one-shot frame — so re-assert a working frame on an interval.
// 80ms matches Pi's cadence (smooth but under the IPC budget). opencode needs only one frame but reuses this for consistent animated UX.
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

function sendSyntheticTitle(ptyId: string, data: string, options: { force?: boolean } = {}): void {
  const window = state.mainWindow
  if (!window || window.isDestroyed()) {
    return
  }
  // Why: throttle decorative spinner frames (up to 80ms/agent); final/permission frames are forced because they drive BEL.
  if (
    !shouldSendSyntheticTitleFrame({
      force: options.force === true,
      windowVisible: isSyntheticTitleWindowVisible()
    })
  ) {
    return
  }
  // Why: feed the per-PTY tracker directly, never onPtyData — emulator/tails/transcripts/stats must not see fabricated bytes.
  state.runtime?.ingestSyntheticTitleFrame(ptyId, data)
  // Why: only the kill-switch-off renderer byte-parses synthetic frames; under main authority the copy mints phantom ACKs (see synthetic-title-frame-routing.ts).
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

export function stopAllSyntheticTitleSpinners(): void {
  syntheticTitleSpinnerByPaneKey.clear()
  stopSyntheticTitleSpinnerTimer()
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
  // Why: one shared timer for all spinners — per-pane intervals multiplied idle wakeups when several agents were working.
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
    // Why: emit the first frame immediately so the spinner is visible now, not up to 80ms later at the next interval tick.
    const existing = syntheticTitleSpinnerByPaneKey.get(paneKey)
    const frame = existing ? existing.frame : 0
    sendSyntheticTitle(ptyId, `\x1b]0;${SPINNER_FRAMES[frame]} ${profile.workingLabel}\x07`)
    if (existing) {
      // Why: refresh the profile so a mid-pane agent-type change lands on the right idle/permission labels at terminal state.
      existing.profile = profile
      return
    }
    syntheticTitleSpinnerByPaneKey.set(paneKey, { frame, profile })
    ensureSyntheticTitleSpinnerTimer()
    return
  }
  // Why: stop the spinner first so the next tick can't race the state back to "working", then inject the terminal frame.
  // Permission frames add a trailing BEL to light up user-input states; done frames omit it (completion notifications own that attention).
  stopSyntheticTitleSpinner(paneKey)
  const needsUserInput = agentState === 'blocked' || agentState === 'waiting'
  const label = needsUserInput ? profile.permissionLabel : profile.idleLabel
  sendSyntheticTitle(ptyId, `\x1b]0;${label}\x07${needsUserInput ? '\x07' : ''}`, { force: true })
}

export function shouldSuppressCodexAutoApprovalSyntheticTitleFromHook(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  launchConfig:
    | { agentArgs?: string | null; agentEnv?: Record<string, string> | null }
    | null
    | undefined
}): boolean {
  if (args.agentType !== 'codex' || (args.state !== 'waiting' && args.state !== 'blocked')) {
    return false
  }
  if (!args.launchConfig) {
    return false
  }
  return (
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  )
}

export function initializeSyntheticTitleRuntime(): void {
  // Why: on PTY teardown drop the spinner entry explicitly, else the shared timer keeps ticking with sendSyntheticTitle no-oping forever.
  registerPaneKeyTeardownListener((paneKey) => stopSyntheticTitleSpinner(paneKey))
  // Why: the spinner is a stand-in for a live hook status, so it must retire with the row it
  // stands in for — otherwise a pane whose status was cleared or dismissed keeps rotating a
  // working title long after the agent finished (#13890). Both paths are covered: the
  // pane-scoped clear fan-out, and user dismissal, which never routes through it.
  agentHookServer.subscribePaneStatusClear((clear) => {
    const paneKey = getSyntheticTitleSpinnerPaneKeyToStop(clear)
    if (paneKey) {
      stopSyntheticTitleSpinner(paneKey)
    }
  })
  agentHookServer.subscribeStatusDrop(stopSyntheticTitleSpinner)
}

export function driveSyntheticTitleForAgentStatus(
  paneKey: string,
  agentType: string | null | undefined,
  agentState: AgentStatusState
): void {
  const profile = getSyntheticAgentTitleProfile(agentType)
  if (profile && shouldDriveSyntheticAgentTitleFromHook(agentType, agentState)) {
    driveSyntheticTitleFromHook(paneKey, agentState, profile)
  }
}
