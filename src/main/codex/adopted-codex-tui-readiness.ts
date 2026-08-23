// Off-screen readiness proof for a Codex TUI resumed inside a pane Orca already
// owns. Adoption stops the pane's Codex and types a `codex resume` line into the
// bare shell that is left; nothing on screen can tell that shell apart from a
// Codex that has finished starting. The CLI's own SessionStart hook can: it is
// emitted by the resumed process itself, carries the conversation it reopened,
// and reaches Orca over the hook endpoint instead of the terminal buffer.
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'

export type AdoptedCodexReadinessEvent = Pick<
  AgentHookEventPayload,
  'paneKey' | 'source' | 'hookEventName' | 'isReplay' | 'sessionNonce' | 'providerSession'
>

export type AdoptedCodexReadinessVerdict = 'ignore' | 'ready' | 'wrong-session'

export type AdoptedCodexReadinessTarget = {
  paneKey: string
  threadId: string
  sessionNonce: string
}

export const ADOPTED_CODEX_READINESS_TIMEOUT_MS = 30_000

export function classifyAdoptedCodexReadinessEvent(
  event: AdoptedCodexReadinessEvent,
  target: AdoptedCodexReadinessTarget
): AdoptedCodexReadinessVerdict {
  if (
    event.source !== 'codex' ||
    event.hookEventName !== 'SessionStart' ||
    event.isReplay === true ||
    event.paneKey !== target.paneKey
  ) {
    return 'ignore'
  }
  // A hook script installed by an older Orca omits the nonce entirely. Pane + thread
  // still bind it, so degrade rather than strand the return path — but a nonce that
  // IS present and disagrees names a different invocation, which is the stale
  // SessionStart this gate exists to reject.
  if (event.sessionNonce !== undefined && event.sessionNonce !== target.sessionNonce) {
    return 'ignore'
  }
  const observedThreadId = event.providerSession?.id
  if (!observedThreadId) {
    return 'ignore'
  }
  if (observedThreadId === target.threadId) {
    return 'ready'
  }
  // Only our own nonce makes a mismatch conclusive; without one this could be any
  // Codex sharing the pane's env.
  return event.sessionNonce === target.sessionNonce ? 'wrong-session' : 'ignore'
}

export type AdoptedCodexReadinessWatch = {
  /** Resolves when the resumed Codex proves itself; rejects on timeout or a wrong thread. */
  readonly settled: Promise<void>
  dispose(): void
}

/**
 * Starts listening BEFORE the resume command is written — a fast Codex can emit
 * SessionStart before the write call even returns.
 */
export function beginAdoptedCodexReadinessWatch(input: {
  subscribe: (listener: (event: AdoptedCodexReadinessEvent) => void) => () => void
  target: AdoptedCodexReadinessTarget
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}): AdoptedCodexReadinessWatch {
  const setTimer = input.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as never))
  let finish: ((error: Error | null) => void) | null = null
  const settled = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
  })
  let unsubscribe: (() => void) | null = null
  let timer: unknown = null
  const settle = (error: Error | null): void => {
    if (!finish) {
      return
    }
    const complete = finish
    finish = null
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    unsubscribe?.()
    unsubscribe = null
    complete(error)
  }
  unsubscribe = input.subscribe((event) => {
    const verdict = classifyAdoptedCodexReadinessEvent(event, input.target)
    if (verdict === 'ready') {
      settle(null)
    } else if (verdict === 'wrong-session') {
      settle(new Error('The agent terminal resumed a different Codex session.'))
    }
  })
  timer = setTimer(() => {
    settle(new Error('The agent terminal did not report the resumed Codex session.'))
  }, input.timeoutMs ?? ADOPTED_CODEX_READINESS_TIMEOUT_MS)
  return {
    settled,
    dispose: () => settle(new Error('The agent terminal stopped resuming Codex.'))
  }
}
