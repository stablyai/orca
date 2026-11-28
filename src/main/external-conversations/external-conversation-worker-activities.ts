// One read of what each chat conversation's orchestration workers are doing, as their execution
// hosts tell it.
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  sessionWorkerIsRunning,
  sessionWorkerIsWorking,
  type OrchestrationSessionWorker
} from '../../shared/orchestration-session-workers'
import type { ConversationBots } from './external-conversation-bots'
import type { ConversationWorkerActivity } from './external-conversation-worker-view'

export type ReadWorker = Pick<
  OrchestrationSessionWorker,
  'state' | 'activity' | 'pendingQuestion'
> & {
  /** Workers it started itself are still open. */
  helpersRunning?: boolean
}

export type ConversationWorkersHost = {
  /** The workers each of these chats started that may still run, as its orchestration records and
   *  their hosts tell them; one read for them all. */
  read: (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, readonly ReadWorker[]>>
}

/** A conversation's activity as one read found it, and whether a running worker of it has open
 *  workers of its own; `unread` where that read failed. */
export type ConversationWorkerAnswer =
  | { activity: ConversationWorkerActivity; helpersRunning: boolean }
  | 'unread'

/** Each conversation's activity, by session id, in one read; a paused or removed bot's workers no
 *  longer hold its conversation, whether or not the others' read succeeds. Null where none can be read. */
export async function conversationWorkerActivities(
  host: { workers?: ConversationWorkersHost; bots?: ConversationBots },
  links: readonly ExternalConversationLink[]
): Promise<ReadonlyMap<string, ConversationWorkerAnswer> | null> {
  if (!host.workers) {
    return null
  }
  const refused = new Set(
    links.flatMap((link) =>
      link.bot && host.bots?.refusal(link.bot.botId) ? [link.sessionId] : []
    )
  )
  const read = links.flatMap((link) => (refused.has(link.sessionId) ? [] : [link.sessionId]))
  let workers: Awaited<ReturnType<ConversationWorkersHost['read']>> | null = new Map()
  if (read.length > 0) {
    try {
      workers = await host.workers.read([...new Set(read)])
    } catch (error) {
      console.warn('[connector] could not read conversations’ workers', error)
      workers = null
    }
  }
  return new Map(
    links.map((link): [string, ConversationWorkerAnswer] => [
      link.sessionId,
      refused.has(link.sessionId)
        ? { activity: 'none', helpersRunning: false }
        : workers
          ? workerActivityOf(workers.get(link.sessionId) ?? [])
          : 'unread'
    ])
  )
}

function workerActivityOf(
  workers: readonly ReadWorker[]
): Exclude<ConversationWorkerAnswer, 'unread'> {
  const running = workers.filter(sessionWorkerIsRunning)
  return {
    activity: running.some(sessionWorkerIsWorking)
      ? 'working'
      : running.some((worker) => worker.state === 'unverifiable')
        ? 'unverifiable'
        : running.length > 0
          ? 'idle'
          : 'none',
    helpersRunning: running.some((worker) => worker.helpersRunning === true)
  }
}
