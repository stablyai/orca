import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
import {
  classifyTerminalCreationFailure,
  readTerminalStartFailure,
  terminalExitError
} from '../../shared/terminal-start-failure'
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
import { failOnLaunchedAgentExit, type LaunchedAgentExitRuntime } from './launched-agent-exit-watch'
import { showsHoldAnchor } from './agent-state-rules/agent-state-text-anchors'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

export type LaunchedAgentReadinessLane = 'composer-marker' | 'tui-idle'

export function getLaunchedAgentReadinessLane(agent: TuiAgent): LaunchedAgentReadinessLane {
  return TUI_AGENT_CONFIG[agent].composerReadyCaptures?.length ? 'composer-marker' : 'tui-idle'
}

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
> &
  Partial<Pick<OrcaRuntimeService, 'getPtyLivenessVerdict'> & LaunchedAgentExitRuntime>

export type TerminalReadinessCreation = Pick<
  RuntimeTerminalCreate,
  'handle' | 'ptyId' | 'incarnationId' | 'isReattach' | 'agentSessionDisposition'
>

/** The PTY this creation spawned for `handle`; a reattached or adopted pane launched nothing new. */
function freshLaunchPtyId(
  handle: string,
  creation: TerminalReadinessCreation | undefined
): string | null {
  return creation &&
    creation.handle === handle &&
    !creation.isReattach &&
    creation.agentSessionDisposition !== 'adopted' &&
    creation.ptyId
    ? creation.ptyId
    : null
}

function readinessFailure(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  creation: TerminalReadinessCreation | undefined,
  error: unknown
): unknown {
  if (readTerminalStartFailure(error)) {
    return error
  }
  const ptyId = freshLaunchPtyId(handle, creation)
  const verdict = ptyId ? runtime.getPtyLivenessVerdict?.(ptyId) : null
  if (
    !ptyId ||
    !creation?.incarnationId ||
    verdict?.status !== 'exited' ||
    verdict.incarnationId !== creation.incarnationId
  ) {
    return error
  }
  return classifyTerminalCreationFailure(error, {
    id: ptyId,
    incarnationId: creation.incarnationId
  })
}

function observesLaunchedAgentExit(
  runtime: LaunchedAgentReadinessRuntime
): runtime is LaunchedAgentReadinessRuntime & LaunchedAgentExitRuntime {
  return (
    runtime.readLaunchedAgentForeground !== undefined &&
    runtime.subscribeToTerminalData !== undefined &&
    runtime.readRecentTerminalOutput !== undefined
  )
}

function waitWatchingForAgentExit(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  creation: TerminalReadinessCreation | undefined,
  signal: AbortSignal | undefined,
  wait: (signal?: AbortSignal) => Promise<RuntimeTerminalWait>
): Promise<RuntimeTerminalWait> {
  const ptyId = freshLaunchPtyId(handle, creation)
  return ptyId && observesLaunchedAgentExit(runtime)
    ? failOnLaunchedAgentExit(runtime, ptyId, agent, signal, wait)
    : wait(signal)
}

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
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeTerminalWait> {
  const abort = signal ? { signal } : {}
  if (getLaunchedAgentReadinessLane(agent) === 'composer-marker') {
    return signal
      ? runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, abort)
      : runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
  }
  if (!workerStartReadsComposerMarker(agent)) {
    return runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs,
      launchReadiness: true,
      ...abort
    })
  }
  const stop = new AbortController()
  const lanes = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  try {
    return await firstAnswer(
      runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs,
        launchReadiness: true,
        signal: lanes
      }),
      runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, {
        requireComposerMarker: true,
        signal: lanes
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

export async function waitForWorkerAgentReady(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  args: {
    agent: TuiAgent | undefined
    reusesTerminal: boolean
    timeoutMs: number
    creation?: TerminalReadinessCreation
  }
): Promise<RuntimeTerminalWait> {
  const { agent } = args
  try {
    const result = await (agent && !args.reusesTerminal
      ? waitWatchingForAgentExit(runtime, handle, agent, args.creation, undefined, (signal) =>
          waitForWorkerStartComposer(runtime, handle, agent, args.timeoutMs, signal)
        )
      : runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: args.timeoutMs }))
    return args.reusesTerminal
      ? result
      : requireFreshReadiness(runtime, handle, args.creation, result)
  } catch (error) {
    throw args.reusesTerminal ? error : readinessFailure(runtime, handle, args.creation, error)
  }
}

function requireFreshReadiness(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  creation: TerminalReadinessCreation | undefined,
  result: RuntimeTerminalWait
): RuntimeTerminalWait {
  if (result.status === 'exited') {
    const error = readinessFailure(
      runtime,
      handle,
      creation,
      terminalExitError('terminal_exited', result.exitCause)
    )
    if (readTerminalStartFailure(error)) {
      throw error
    }
  }
  return result
}

/** Fall back from composer detection to tui-idle using only the remaining launch budget. */
async function waitForLaunchedAgentComposerImpl(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number,
  signal?: AbortSignal,
  creation?: TerminalReadinessCreation
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
  } catch (error) {
    const failure = readinessFailure(runtime, handle, creation, error)
    if (readTerminalStartFailure(failure)) {
      throw failure
    }
    // tui-idle classifies timeout/dialog/unreadable panes and rejects lost handles.
  }
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    launchReadiness: true,
    ...abort
  })
}

export async function waitForLaunchedAgentComposer(
  ...args: Parameters<typeof waitForLaunchedAgentComposerImpl>
): Promise<RuntimeTerminalWait> {
  const [runtime, handle, agent, timeoutMs, signal, creation] = args
  try {
    return requireFreshReadiness(
      runtime,
      handle,
      creation,
      await waitWatchingForAgentExit(runtime, handle, agent, creation, signal, (watchSignal) =>
        waitForLaunchedAgentComposerImpl(runtime, handle, agent, timeoutMs, watchSignal, creation)
      )
    )
  } catch (error) {
    throw readinessFailure(runtime, handle, creation, error)
  }
}
