/** Fresh-launch signals require shell handoff plus dialog/provisional-header vetoes; shells also enable bracketed paste.
 * Captured-marker agents wait for their marker; others may fall back to tui-idle within the remaining budget.
 * Readiness alone never authorizes writing: the foreground guard must still admit the agent. */

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { draftPasteReadySignalHasMarker } from '../../shared/draft-paste-ready-scanner'
import { nameOnlyIdleNeedsCorroboration } from './tui-idle-evidence'
import type { OrcaRuntimeService } from './orca-runtime'
import { showsHoldAnchor } from './agent-state-rules/agent-state-text-anchors'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

export type LaunchedAgentReadinessLane = 'composer-marker' | 'tui-idle'

export function getLaunchedAgentReadinessLane(agent: TuiAgent): LaunchedAgentReadinessLane {
  return TUI_AGENT_CONFIG[agent].composerReadyCaptures?.length ? 'composer-marker' : 'tui-idle'
}

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

/** Startup dialogs and hold anchors veto signals; Codex's provisional loading header discards input. */
export function readFreshComposerHold(
  waitText: string,
  screenLines: readonly string[] | null
): 'dialog' | 'starting' | null {
  if (
    detectTerminalWaitBlockedReason(waitText) !== null ||
    (screenLines !== null && detectTerminalWaitBlockedReason(screenLines.join('\n')) !== null)
  ) {
    return 'dialog'
  }
  return showsHoldAnchor(waitText.toLowerCase()) ? 'starting' : null
}

/** Workers wait for proven markers or tui-idle; their pre-Enter render wait avoids the desktop paste's later cue. */
export async function waitForWorkerStartComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  if (getLaunchedAgentReadinessLane(agent) === 'composer-marker') {
    return runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
  }
  if (!workerStartReadsComposerMarker(agent)) {
    return runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs,
      launchReadiness: true
    })
  }
  const stop = new AbortController()
  try {
    return await firstAnswer(
      runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs,
        launchReadiness: true,
        signal: stop.signal
      }),
      runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, {
        requireComposerMarker: true,
        signal: stop.signal
      })
    )
  } finally {
    stop.abort()
  }
}

/**
 * An agent whose composer draws a marker, and whose only rest signal is its bare name (which a
 * launch holds to quiet output) or a title the user can turn off: that marker answers first. Grok
 * draws its glyph at 0.6 s, then animates its logo for ten; Claude without its title never settles.
 */
export function workerStartReadsComposerMarker(agent: TuiAgent): boolean {
  const config = TUI_AGENT_CONFIG[agent]
  const signal = config.draftPasteReadySignal
  return (
    signal !== undefined &&
    draftPasteReadySignalHasMarker(signal) &&
    (config.workerStartReadsComposerMarker === true || !nameOnlyIdleNeedsCorroboration(agent))
  )
}

/** First answer wins; reject only after both fail, preferring the idle error. */
function firstAnswer(
  idle: Promise<RuntimeTerminalWait>,
  marker: Promise<RuntimeTerminalWait>
): Promise<RuntimeTerminalWait> {
  return new Promise((resolve, reject) => {
    let failures = 0
    let idleError: unknown
    const fail = (error: unknown, fromIdle: boolean): void => {
      if (fromIdle) {
        idleError = error
      }
      failures += 1
      if (failures === 2) {
        reject(idleError ?? error)
      }
    }
    idle.then(resolve, (error: unknown) => fail(error, true))
    marker.then(resolve, (error: unknown) => fail(error, false))
  })
}

export function waitForWorkerAgentReady(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  args: { agent: TuiAgent | undefined; reusesTerminal: boolean; timeoutMs: number }
): Promise<RuntimeTerminalWait> {
  return args.agent && !args.reusesTerminal
    ? waitForWorkerStartComposer(runtime, handle, args.agent, args.timeoutMs)
    : runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: args.timeoutMs })
}

/** Fall back from composer detection to tui-idle using only the remaining launch budget. */
export async function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeTerminalWait> {
  const abort = signal ? { signal } : {}
  if (getLaunchedAgentReadinessLane(agent) === 'composer-marker') {
    return signal
      ? runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, abort)
      : runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
  }
  const startedAt = Date.now()
  try {
    return await runtime.waitForFreshWorkerComposer(
      handle,
      agent,
      Math.min(timeoutMs, resolveDraftPasteReadyTimeoutMs(agent)),
      { requireComposerMarker: false, stopOnDialog: true, ...abort }
    )
  } catch {
    // tui-idle classifies timeout/dialog/unreadable panes and rejects lost handles.
  }
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    launchReadiness: true,
    ...abort
  })
}
