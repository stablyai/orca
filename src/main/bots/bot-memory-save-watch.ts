// At a bot chat's turn end: whether to ask it to save memory before its context fills. One save per
// context window (bot-memory-save-window.ts), only while the chat is idle, and never for workers,
// automation runs, look-arounds, tidy-ups or group rooms. The save is Orca's own turn
// (`origin: 'memory-save'`), which the chat draws as a divider and which no one can steer into.
import type { AgentSessionContextUsage } from '../../shared/agent-session/conversation-context/agent-session-context-usage'
import { selectStructuredAgentContextUsage } from '../../shared/agent-session/conversation-context/structured-agent-session-context-usage'
import type { AgentJournalMemorySave } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import {
  BOT_MEMORY_SAVE_ATTEMPTED,
  botMemorySaveReading,
  botMemorySaveStep
} from '../../shared/bots/bot-memory-save-window'
import type { BotMemorySaveLedger } from './bot-memory-save-ledger'

// Workflow only: what to save and where, never how the bot should sound.
export const BOT_MEMORY_SAVE_PROMPT =
  '[Orca: this chat\'s context is getting full. Save what should outlast this context. Owner rules, decisions, preferences and lessons go in MEMORY.md as dated lines, with details in memory/<topic>.md; change or remove a line with `orca bot memory forget`. Put the status of open work in your items (`orca bot item …`), not MEMORY.md. Don\'t start new work, message anyone or post anywhere. Reply with one short line saying what you saved, or "No memory changes."]'

export type BotMemorySaveWatchDeps = {
  ledger: BotMemorySaveLedger
  /** The bot whose own Home or connector chat this is, unpaused; null for anything else. */
  ownChatBot: (sessionId: string) => string | null
  /** The chat's newest context facts, as the composer ring reads them. */
  contextUsage: (sessionId: string) => Promise<AgentSessionContextUsage>
  /** Nothing running, no prompt open, nothing queued and nothing blocking a send. */
  idle: (sessionId: string) => Promise<boolean>
  send: (botId: string, sessionId: string, memorySave: AgentJournalMemorySave) => Promise<void>
  warn?: (message: string, error: unknown) => void
  /** Runs `check` later; a due save that found the chat busy looks again a bounded number of times,
   *  since a turn end can be seen before its chat reads idle. */
  later?: (check: () => void, delayMs: number) => void
}

/** Second looks for a due save that found the chat busy; a later turn end starts over. */
export const BOT_MEMORY_SAVE_BUSY_RECHECK_MS = [1_000, 5_000] as const

function unrefLater(check: () => void, delayMs: number): void {
  setTimeout(check, delayMs).unref?.()
}

export type BotMemorySaveWatch = {
  /** Resolves once this turn end's decision (and any send) is made; never rejects. */
  turnEnded: (sessionId: string) => Promise<void>
}

/** The ring's own number and hedge, so the divider and the composer agree at the moment of saving. */
function ringReading(usage: AgentSessionContextUsage): AgentJournalMemorySave {
  const ring = selectStructuredAgentContextUsage([], usage)
  return ring ? { percent: ring.percentage, estimated: ring.estimated } : {}
}

export function createBotMemorySaveWatch(deps: BotMemorySaveWatchDeps): BotMemorySaveWatch {
  // One decision per chat at a time: two quick turn ends can't both start a save.
  const deciding = new Map<string, Promise<void>>()
  const later = deps.later ?? unrefLater
  const decide = async (sessionId: string, recheck = 0): Promise<void> => {
    const botId = deps.ownChatBot(sessionId)
    if (!botId) {
      return
    }
    const usage = await deps.contextUsage(sessionId)
    const reading = botMemorySaveReading(usage)
    if (!reading) {
      return
    }
    const state = await deps.ledger.read(sessionId)
    if (!state) {
      return
    }
    const step = botMemorySaveStep(state, reading)
    if (step.state !== state) {
      await deps.ledger.write(sessionId, step.state)
    }
    if (!step.due) {
      return
    }
    if (!(await deps.idle(sessionId))) {
      const delay = BOT_MEMORY_SAVE_BUSY_RECHECK_MS[recheck]
      if (delay !== undefined) {
        later(() => void enqueue(sessionId, () => decide(sessionId, recheck + 1)), delay)
      }
      return
    }
    // The attempt uses this window whatever happens next, and is on disk before the send, so no
    // failure, Stop or restart can start a second save until usage drops and fills up again.
    await deps.ledger.write(sessionId, BOT_MEMORY_SAVE_ATTEMPTED)
    await deps.send(botId, sessionId, ringReading(usage))
  }
  const enqueue = (sessionId: string, run: () => Promise<void>): Promise<void> => {
    const previous = deciding.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(run)
      .catch((error: unknown) => deps.warn?.('[bots] memory save check failed', error))
      .finally(() => {
        if (deciding.get(sessionId) === next) {
          deciding.delete(sessionId)
        }
      })
    deciding.set(sessionId, next)
    return next
  }
  return { turnEnded: (sessionId) => enqueue(sessionId, () => decide(sessionId)) }
}
