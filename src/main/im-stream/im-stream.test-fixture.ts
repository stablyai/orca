import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ImStreamTimer } from './im-stream-throttle'

/** A clock and timer the test moves by hand. */
export function manualClock() {
  let now = 0
  const timers: { at: number; run: () => void }[] = []
  const timer: ImStreamTimer = (run, ms) => {
    const entry = { at: now + ms, run }
    timers.push(entry)
    return () => {
      const index = timers.indexOf(entry)
      if (index !== -1) {
        timers.splice(index, 1)
      }
    }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  // Lets pending work register its timers before each one is due.
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      await settle()
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) {
        break
      }
      timers.shift()
      now = Math.max(now, next.at)
      next.run()
    }
    now = until
    await settle()
  }
  return { now: () => now, timer, advance }
}

/** Journal rows built in order: a root turn and rows inside it. */
export function journalRows() {
  let sequence = 0
  const next = (
    body: AgentJournalRenderItem['body'],
    turnItemId: string | null,
    itemId?: string
  ): AgentJournalRenderItem => {
    sequence += 1
    return {
      itemId: itemId ?? `item-${sequence}`,
      revision: 1,
      body,
      sequence,
      observedAt: sequence * 1000,
      turnScope: turnItemId === null ? { kind: 'thread' } : { kind: 'turn', turnItemId }
    }
  }
  return {
    turn: (
      itemId: string,
      state: 'running' | 'completed' | 'interrupted',
      times: { requestedAt?: number; completedAt?: number } = {}
    ) => next({ kind: 'turn', turnId: `provider-${itemId}`, state, ...times }, null, itemId),
    answer: (turnItemId: string, text: string) =>
      next({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }, turnItemId),
    thought: (turnItemId: string, text: string) =>
      next({ kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text }] }, turnItemId)
  }
}
