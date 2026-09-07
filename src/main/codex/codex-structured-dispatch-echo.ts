import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'

// Correlates a Codex `turn/start` dispatch with the `userMessage` item Codex
// echoes back for it: Orca sends `clientUserMessageId`, the echo carries it as
// `clientId`, and the echo's journal identity names the submission — including
// the true ordinal of a send Codex coalesced into an already-running turn.
// Mirrors the Claude adapter's dispatch waiters (claude-structured-dispatch.ts).

const MAX_RETIRED_ECHO_WAITERS = 64

/** A live `userMessage` item as the journal translator identified it. */
export type CodexUserMessageEcho = {
  threadId: string
  /** Codex's echo of `clientUserMessageId`; null on builds that predate it. */
  clientId: string | null
  identity: AgentJournalItemIdentity
}

export type CodexEchoWaiter = {
  clientMessageId: string
  resolve: (identity: AgentJournalItemIdentity | null) => void
  timer?: ReturnType<typeof setTimeout>
  settledIdentity?: AgentJournalItemIdentity
  retired?: boolean
}

export type CodexDispatchEchoes = {
  waiters: CodexEchoWaiter[]
  retired: CodexEchoWaiter[]
  /** Once one exact `clientId` echo is seen this build provably correlates, so
   *  a missing echo means undelivered — the positional fallback stays off. */
  sawClientIdEcho: boolean
}

/** A dispatch whose echo window expired, proven delivered by this late echo. */
export type CodexLateEchoSettlement = (input: {
  clientMessageId: string
  providerIdentity: AgentJournalItemIdentity
}) => void

export function createCodexDispatchEchoes(): CodexDispatchEchoes {
  return { waiters: [], retired: [], sawClientIdEcho: false }
}

/** Register BEFORE `turn/start` goes out: the echo can race the response. */
export function registerCodexEchoWaiter(
  echoes: CodexDispatchEchoes,
  clientMessageId: string
): { waiter: CodexEchoWaiter; promise: Promise<AgentJournalItemIdentity | null> } {
  let waiter!: CodexEchoWaiter
  const promise = new Promise<AgentJournalItemIdentity | null>((resolve) => {
    waiter = { clientMessageId, resolve }
    echoes.waiters.push(waiter)
  })
  return { waiter, promise }
}

/** Armed only after the `turn/start` response classified the send, so fresh
 *  and coalesced turns get different windows. No-op once settled or armed. */
export function armCodexEchoTimeout(
  echoes: CodexDispatchEchoes,
  waiter: CodexEchoWaiter,
  timeoutMs: number
): void {
  if (!echoes.waiters.includes(waiter) || waiter.timer) {
    return
  }
  waiter.timer = setTimeout(() => {
    removeWaiter(echoes.waiters, waiter)
    waiter.resolve(null)
  }, timeoutMs)
  waiter.timer.unref?.()
}

/** Drops a waiter whose dispatch failed outright; no echo is owed. */
export function discardCodexEchoWaiter(echoes: CodexDispatchEchoes, waiter: CodexEchoWaiter): void {
  clearTimeout(waiter.timer)
  removeWaiter(echoes.waiters, waiter)
  removeWaiter(echoes.retired, waiter)
  waiter.resolve(null)
}

/** Parks an expired waiter so a late echo can still settle its submission. */
export function retireCodexEchoWaiter(echoes: CodexDispatchEchoes, waiter: CodexEchoWaiter): void {
  clearTimeout(waiter.timer)
  removeWaiter(echoes.waiters, waiter)
  if (!waiter.retired) {
    waiter.retired = true
    echoes.retired.push(waiter)
    if (echoes.retired.length > MAX_RETIRED_ECHO_WAITERS) {
      echoes.retired.splice(0, echoes.retired.length - MAX_RETIRED_ECHO_WAITERS)
    }
  }
}

export function resolveCodexUserMessageEcho(
  echoes: CodexDispatchEchoes,
  sessionThreadId: string | null,
  echo: CodexUserMessageEcho,
  onSettledLate?: CodexLateEchoSettlement
): void {
  // A subagent thread's user message must never settle the primary dispatch.
  if (sessionThreadId === null || echo.threadId !== sessionThreadId) {
    return
  }
  // The `orca:` fallback namespace is unstable across resume; wait for a frame
  // that names the turn rather than settling the journal on a throwaway key.
  if (echo.identity.provider !== 'codex') {
    return
  }
  if (echo.clientId !== null) {
    echoes.sawClientIdEcho = true
    const exact = echoes.waiters.find((candidate) => candidate.clientMessageId === echo.clientId)
    if (exact) {
      settleWaiter(echoes, exact, echo.identity)
      return
    }
    const retired = echoes.retired.find((candidate) => candidate.clientMessageId === echo.clientId)
    if (retired) {
      removeWaiter(echoes.retired, retired)
      onSettledLate?.({ clientMessageId: retired.clientMessageId, providerIdentity: echo.identity })
    }
  }
  // An ID-less lifecycle frame can belong to an earlier send, even with one waiter.
}

/** Session teardown: an unresolved waiter would otherwise stall its dispatch. */
export function settleCodexEchoWaitersOnClose(echoes: CodexDispatchEchoes): void {
  for (const waiter of echoes.waiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
  echoes.retired.length = 0
}

function settleWaiter(
  echoes: CodexDispatchEchoes,
  waiter: CodexEchoWaiter,
  identity: AgentJournalItemIdentity
): void {
  removeWaiter(echoes.waiters, waiter)
  clearTimeout(waiter.timer)
  waiter.settledIdentity = identity
  waiter.resolve(identity)
}

function removeWaiter(list: CodexEchoWaiter[], waiter: CodexEchoWaiter): void {
  const index = list.indexOf(waiter)
  if (index !== -1) {
    list.splice(index, 1)
  }
}
