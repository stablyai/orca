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

// A decision that could not be made (an unreadable fact, a sender not verifiable yet) is retried.
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000]
const STARTUP_CONCURRENCY = 3

// One decision per chat at a time; an edge during it asks for one more after.
const deciding = new Map<string, { again: boolean; done: Promise<void> }>()
const retries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>()
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
  reader: QuestionRestReader | null = hostRestReader()
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
    try {
      do {
        entry.again = false
        owed = await decide(runtime, db, sessionId, reader)
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
  const holds = reader?.restartHolds()
  const pass = reader && holds ? { ...reader, restartHolds: () => holds } : reader
  // A few at a time: an unloaded chat may read its saved usage-limit cut from disk.
  const queue = [...sessions]
  await Promise.all(
    Array.from({ length: Math.min(STARTUP_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await reconcileBotRequestTakes(runtime, next, pass)
      }
    })
  )
}

/** True when a decision is owed but couldn't be made now. */
async function decide(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  sessionId: string,
  reader: QuestionRestReader | null
): Promise<boolean> {
  // Read before any wait: a request a later turn takes is never decided by this read.
  const takes = db.listOpenBotRequestTakes(sessionId)
  if (takes.length === 0) {
    return false
  }
  // A person who deleted it unread released it, whatever the chat does.
  const due: { take: BotRequestRow; why: BotRequestUnansweredWhy }[] = takes
    .filter((take) => take.taken_by === 'person')
    .map((take) => ({ take, why: 'withdrawn' }))
  const read = takes.filter((take) => take.taken_by !== 'person')
  const rest = read.length > 0 && reader ? await restWhy(reader, sessionId) : 'held'
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
  due.forEach(({ why }, index) => {
    const message = messages[index]
    const told =
      !message ||
      tellSender(runtime, db, message, {
        outcome: why === 'withdrawn' ? 'dropped' : 'unanswered',
        why,
        ...(why === 'failed' && reason ? { reason } : {}),
        takenBy: sessionId,
        once: true
      })
    owed ||= !told
  })
  return owed
}

/** Why the chat stopped without answering; `held` while it may still answer, `unknown` when a fact
 *  it depends on can't be read now. */
async function restWhy(
  reader: QuestionRestReader,
  sessionId: string
): Promise<BotRequestUnansweredWhy | 'held' | 'unknown'> {
  const rest = await reader.readQuestionRest(sessionId)
  if (!rest) {
    return 'unknown'
  }
  if (rest.kind === 'busy' || (await reader.restartHolds()).has(sessionId)) {
    return 'held'
  }
  if (rest.kind === 'closed' || rest.outcome === 'failure') {
    const continues = await reader.willContinue(sessionId)
    if (continues !== false) {
      return continues === null ? 'unknown' : 'held'
    }
  }
  if (rest.kind === 'closed') {
    return 'ended'
  }
  return rest.outcome === 'failure'
    ? 'failed'
    : rest.outcome === 'cancellation'
      ? 'stopped'
      : 'ended'
}

/** Backs off while a decision stays owed; any decision that settles resets it. */
function scheduleRetry(
  runtime: OrcaRuntimeService,
  sessionId: string,
  owed: boolean,
  reader: QuestionRestReader | null
): void {
  const previous = retries.get(sessionId)
  if (previous) {
    clearTimeout(previous.timer)
  }
  const attempt = owed ? (previous?.attempt ?? -1) + 1 : -1
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) {
    // Settled, or out of retries: the chat's next edge or the next start decides it.
    retries.delete(sessionId)
    return
  }
  const timer = setTimeout(() => void reconcileBotRequestTakes(runtime, sessionId, reader), delay)
  timer.unref?.()
  retries.set(sessionId, { attempt, timer })
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
