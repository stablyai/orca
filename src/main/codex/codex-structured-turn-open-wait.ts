import type { AgentSessionCancelOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  codexThreadStoppedRunning,
  readCodexThreadId,
  readCodexTurnId
} from './codex-structured-thread-facts'

/** Waits share the eviction budget with provider close; overruns leave lease settlement to recovery. */
export const CODEX_TURN_OPEN_WAIT_MS = 5_000

export type CodexTurnOpenWaits = {
  /** Wake on turn boundaries, idle/systemError, child exit or the deadline. */
  wait: (turnId: string, withinMs: number) => Promise<void>
  observe: (threadId: string, method: string, params: unknown) => void
  releaseAll: () => void
}

export function createCodexTurnOpenWaits(): CodexTurnOpenWaits {
  const waits = new Map<() => void, string>()
  const release = (turnId?: string): void => {
    for (const [endWait, waitedTurnId] of waits) {
      if (turnId === undefined || waitedTurnId === turnId) {
        endWait()
      }
    }
  }
  return {
    wait: (turnId, withinMs) =>
      new Promise<void>((resolve) => {
        const endWait = (): void => {
          clearTimeout(bound)
          waits.delete(endWait)
          resolve()
        }
        const bound = setTimeout(endWait, withinMs)
        // Pending Stops must not keep the process alive at quit.
        bound.unref?.()
        waits.set(endWait, turnId)
      }),
    observe: (threadId, method, params) => {
      if ((readCodexThreadId(params) ?? threadId) !== threadId) {
        return
      }
      if (method === 'thread/status/changed' && codexThreadStoppedRunning(params)) {
        release()
        return
      }
      const turnId = readCodexTurnId(params)
      if (turnId && (method === 'turn/started' || method === 'turn/completed')) {
        release(turnId)
      }
    },
    releaseAll: () => release()
  }
}

export type CodexStopTarget = { turnId: string } | { opening: string } | null

type CodexOpeningTurnSession = {
  threadId: string
  activeTurnIds?: ReadonlySet<string>
  dispatchEchoes: Pick<
    CodexDispatchEchoes,
    'answeredUnopenedTurn' | 'leftUnopened' | 'answeredTurnLeftUnopened'
  >
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}

/** Timed-out opening turns remain Stop targets until opened or ended. */
export function codexStopTarget(session: CodexOpeningTurnSession): CodexStopTarget {
  const running = [...(session.activeTurnIds ?? [])].at(-1)
  if (running) {
    return { turnId: running }
  }
  const open = session.activeTurnIds ?? new Set<string>()
  const opening =
    session.dispatchEchoes.answeredUnopenedTurn(session.threadId, open) ??
    session.dispatchEchoes.answeredTurnLeftUnopened(session.threadId, open)
  return opening ? { opening } : null
}

const CODEX_NO_ACTIVE_TURN_TO_INTERRUPT = 'no active turn to interrupt'

/** Interrupt immediately; retry once after opening if Codex reports no active turn. */
export async function interruptOpeningCodexTurn(
  session: CodexOpeningTurnSession,
  turnId: string,
  interrupt: () => Promise<AgentSessionCancelOutcome>,
  stillCurrent: () => boolean
): Promise<AgentSessionCancelOutcome> {
  const open = (): ReadonlySet<string> => session.activeTurnIds ?? new Set<string>()
  const first = await interrupt()
  if (first.cancelled || first.refusal?.detail?.text !== CODEX_NO_ACTIVE_TURN_TO_INTERRUPT) {
    return first
  }
  const opened = (): boolean => open().has(turnId)
  const stillOpening = (): boolean => {
    const target = codexStopTarget(session)
    return target !== null && 'opening' in target && target.opening === turnId
  }
  if (!opened() && stillOpening()) {
    await session.turnOpenWaits.wait(turnId, CODEX_TURN_OPEN_WAIT_MS)
    if (!stillCurrent()) {
      return { cancelled: false }
    }
  }
  if (opened()) {
    return interrupt()
  }
  if (!stillOpening()) {
    return { cancelled: false }
  }
  // An unopened turn may still run, so the host must close the child.
  return { cancelled: false, refusal: { turnMayOpen: true } }
}

/** Pre-0.148 steering needs an opened turn; wait once per answered turn. */
export async function codexRunningOrOpeningTurn(
  session: CodexOpeningTurnSession,
  signal?: AbortSignal
): Promise<string | null> {
  const running = [...(session.activeTurnIds ?? [])].at(-1)
  if (running) {
    return running
  }
  const answered = session.dispatchEchoes.answeredUnopenedTurn(
    session.threadId,
    session.activeTurnIds ?? new Set<string>()
  )
  if (!answered) {
    return null
  }
  await waitForPromiseWithSignal(
    session.turnOpenWaits.wait(answered, CODEX_TURN_OPEN_WAIT_MS),
    signal
  )
  if (session.activeTurnIds?.has(answered)) {
    return answered
  }
  // Avoid repeating this wait; a later turn/started still establishes a running turn.
  session.dispatchEchoes.leftUnopened(session.threadId, answered)
  return null
}
