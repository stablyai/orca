// One-shot pending-ask registry for the blocking `orca_ask_operator` MCP tool.
// When an agent inside an Orca session asks the operator a question, the
// /matrix/ask route registers a waiter here keyed by the session's pane key and
// holds the HTTP response open until the inbound router resolves it with the
// operator's reply (or a timeout fires). Pure module — no electron import — so
// it stays trivially unit-testable.

export type AskOutcome =
  | { answered: true; answer: string }
  | { answered: false; reason: 'timeout' | 'superseded' }

type PendingAsk = {
  settle: (outcome: AskOutcome) => void
}

const pending = new Map<string, PendingAsk>()

// Registers a one-shot waiter for paneKey. A second ask for the same pane key
// supersedes the first (the earlier blocked tool call settles immediately so it
// stops waiting on a reply the operator will route to the newer question). The
// returned promise settles on operator reply, timeout, or supersede.
export function registerAsk(paneKey: string, timeoutMs: number): Promise<AskOutcome> {
  const existing = pending.get(paneKey)
  if (existing) {
    existing.settle({ answered: false, reason: 'superseded' })
  }
  return new Promise<AskOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      settle({ answered: false, reason: 'timeout' })
    }, timeoutMs)
    const settle = (outcome: AskOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      // Only drop the map entry if it is still ours: a supersede already
      // replaced it with a newer waiter we must not evict.
      if (pending.get(paneKey) === entry) {
        pending.delete(paneKey)
      }
      resolve(outcome)
    }
    const entry: PendingAsk = { settle }
    pending.set(paneKey, entry)
  })
}

// Resolves a pending ask with the operator's answer. Returns true when a waiter
// existed (so the caller knows the reply was consumed by the ask, not the
// terminal), false otherwise.
export function resolveAsk(paneKey: string, answer: string): boolean {
  const entry = pending.get(paneKey)
  if (!entry) {
    return false
  }
  entry.settle({ answered: true, answer })
  return true
}

export function hasPendingAsk(paneKey: string): boolean {
  return pending.has(paneKey)
}
