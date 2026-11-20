// An agent question is decided at the first rest of the chat that took it: answered, or its asker told once.

import type { BotRequestRow } from '../../../../orchestration/db/bot-requests/bot-request-store'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotRequestUnansweredWhy } from '../../../../../bots/bot-request-view'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionQuestionRest } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { ensureSenderRecords, tellSender } from './bot-request-sender-notice'

export type QuestionRestReader = {
  readQuestionRest: (sessionId: string) => Promise<StructuredAgentSessionQuestionRest | null>
  /** Chats Orca may still continue after a restart, from one read of the offers. */
  restartHolds: () => Promise<ReadonlySet<string>>
  /** Whether Orca will continue the chat itself after a usage limit; null when it can't tell yet. */
  willContinue: (sessionId: string) => Promise<boolean | null>
}

// A decision that could not be made (an unreadable fact, a sender not verifiable yet) is retried,
// every 30 minutes once these run out.
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000]
const STARTUP_CONCURRENCY = 3

// One decision per chat at a time; an edge during it asks for one more after.
const deciding = new Map<string, { again: boolean; done: Promise<void> }>()
const retries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>()
type RestartHolds = () => Promise<ReadonlySet<string>>
// The chat's words for its last failed request, for the notice.
const failureReasons = new Map<string, string>()

/** A chat's request failed: its notice, if one is owed, says why. */
export function noteBotRequestFailureReason(
  runtime: OrcaRuntimeService,
  sessionId: string,
  reason: string | undefined
): void {
  const db = runtime.getOpenOrchestrationDb()
  if (reason && db && db.listOpenBotRequestTakes(sessionId).length > 0) {
    failureReasons.set(sessionId, reason)
  } else {
    failureReasons.delete(sessionId)
  }
}

/** Decides the questions a chat took, now that something about its rest may have changed. Reads
 *  only a database this run opened: a profile that never used orchestration holds no question. */
export function reconcileBotRequestTakes(
  runtime: OrcaRuntimeService,
  sessionId: string,
  reader: QuestionRestReader | null = hostRestReader(),
  /** The startup pass's one read of the offers, for this call's first decision only. */
  startupHolds?: RestartHolds
): Promise<void> {
  const db = runtime.getOpenOrchestrationDb()
  if (!db) {
    return Promise.resolve()
  }
  const current = deciding.get(sessionId)
  if (current) {
    current.again = true
    return current.done
  }
  const entry = { again: false, done: Promise.resolve() }
  entry.done = (async () => {
    let owed = false
    let holds = startupHolds
    try {
      do {
        entry.again = false
        owed = await decide(runtime, db, sessionId, reader, holds)
        // An edge during it may have changed the offers.
        holds = undefined
      } while (entry.again)
    } catch (error) {
      owed = true
      console.warn('[orchestration] deciding agent questions a chat took failed', sessionId, error)
    } finally {
      deciding.delete(sessionId)
    }
    scheduleRetry(runtime, sessionId, owed, reader)
  })()
  deciding.set(sessionId, entry)
  return entry.done
}

/** Once per start: every chat still holding an undecided question, against one read of the offers. */
export async function reconcileBotRequestTakesAtStartup(
  runtime: OrcaRuntimeService,
  reader: QuestionRestReader | null = hostRestReader()
): Promise<void> {
  const sessions = runtime.getExistingOrchestrationDb()?.listSessionsWithOpenBotRequestTakes() ?? []
  if (sessions.length === 0) {
    return
  }
  // Read at first need, so a pass where every chat is busy reads nothing.
  let offers: Promise<ReadonlySet<string>> | undefined
  const holds = reader ? () => (offers ??= reader.restartHolds()) : undefined
  // A few at a time: an unloaded chat may read its saved usage-limit cut from disk.
  const queue = [...sessions]
  await Promise.all(
    Array.from({ length: Math.min(STARTUP_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await reconcileBotRequestTakes(runtime, next, reader, holds)
      }
    })
  )
}

/** True when a decision is owed but couldn't be made now. */
async function decide(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  sessionId: string,
  reader: QuestionRestReader | null,
  holds: RestartHolds | undefined
): Promise<boolean> {
  // Read before any wait: a request a later turn takes is never decided by this read.
  const takes = db.listOpenBotRequestTakes(sessionId)
  if (takes.length === 0) {
    return false
  }
  // One released unread is due whatever the chat does.
  const due: { take: BotRequestRow; why: BotRequestUnansweredWhy }[] = takes.flatMap((take) =>
    take.taken_by === 'agent' || !take.taken_by
      ? []
      : [{ take, why: take.taken_by === 'person' ? 'withdrawn' : take.taken_by }]
  )
  const read = takes.filter((take) => take.taken_by === 'agent')
  const rest =
    read.length > 0 && reader
      ? await restWhy(reader, sessionId, holds ?? (() => reader.restartHolds()))
      : 'held'
  if (rest !== 'held' && rest !== 'unknown') {
    due.push(...read.map((take) => ({ take, why: rest })))
  }
  let owed = rest === 'unknown'
  if (due.length === 0) {
    return owed
  }
  const messages = due.map(({ take }) => db.getMessageById(take.message_id))
  await ensureSenderRecords(runtime, messages)
  const reason = failureReasons.get(sessionId)
  failureReasons.delete(sessionId)
  due.forEach(({ take, why }, index) => {
    const message = messages[index]
    const released = take.taken_by !== 'agent'
    const told =
      !message ||
      tellSender(runtime, db, message, {
        outcome: released ? 'dropped' : 'unanswered',
        why,
        ...(why === 'failed' && reason ? { reason } : {}),
        takenBy: sessionId,
        // Only a chat that can still answer says a late answer reaches the asker.
        once: why !== 'paused' && why !== 'deleted' && why !== 'new-chat'
      })
    owed ||= !told
  })
  return owed
}

/** Why the chat stopped without answering; `held` while it may still answer, `unknown` when a fact
 *  it depends on can't be read now. */
async function restWhy(
  reader: QuestionRestReader,
  sessionId: string,
  holds: RestartHolds
): Promise<BotRequestUnansweredWhy | 'held' | 'unknown'> {
  if ((await reader.readQuestionRest(sessionId))?.kind === 'busy') {
    return 'held'
  }
  // What would continue the chat is read before the rest decided on: a continue that started
  // since shows the chat busy there.
  if ((await holds()).has(sessionId)) {
    return 'held'
  }
  const continues = await reader.willContinue(sessionId)
  const rest = await reader.readQuestionRest(sessionId)
  if (!rest) {
    return 'unknown'
  }
  if (rest.kind === 'busy') {
    return 'held'
  }
  if (rest.kind === 'closed' || rest.outcome === 'failure') {
    if (continues !== false) {
      return continues === null ? 'unknown' : 'held'
    }
    return rest.kind === 'closed' ? 'ended' : 'failed'
  }
  return rest.outcome === 'cancellation' ? 'stopped' : 'ended'
}

/** Backs off while a decision stays owed; any decision that settles resets it. An edge's decision
 *  neither spends nor postpones a pending retry. */
function scheduleRetry(
  runtime: OrcaRuntimeService,
  sessionId: string,
  owed: boolean,
  reader: QuestionRestReader | null
): void {
  const retry = retries.get(sessionId)
  if (!owed) {
    if (retry?.timer) {
      clearTimeout(retry.timer)
    }
    retries.delete(sessionId)
    return
  }
  if (retry?.timer) {
    return
  }
  const attempt = retry ? retry.attempt + 1 : 0
  const next: { attempt: number; timer: ReturnType<typeof setTimeout> | null } = {
    attempt,
    timer: null
  }
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
  next.timer = setTimeout(() => {
    next.timer = null
    void reconcileBotRequestTakes(runtime, sessionId, reader)
  }, delay)
  next.timer.unref?.()
  retries.set(sessionId, next)
}

function hostRestReader(): QuestionRestReader | null {
  const host = getStructuredAgentSessionHost()
  return host
    ? {
        readQuestionRest: (sessionId) => host.reads.questionRest(sessionId),
        restartHolds: () => host.restartResume.continuingCuts(),
        willContinue: (sessionId) => host.usageLimitContinue.willContinue(sessionId)
      }
    : null
}
