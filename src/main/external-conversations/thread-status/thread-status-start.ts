// Starts the process's thread status lines: they follow every connector call and every read of a
// linked chat's workers from here on.
import type { Bot } from '../../../shared/bot-types'
import { installSentConnectorCalls } from '../../connector-cloud/connector-sent-calls'
import { installConversationWorkersWatcher } from '../external-conversation-worker-view'
import { ThreadStatus, type ThreadStatusDeps } from './thread-status'

export function startThreadStatus(
  deps: Omit<ThreadStatusDeps, 'runningTurn' | 'botRefused'> & {
    store: ThreadStatusDeps['store'] & { getBots?: () => readonly Bot[] }
  },
  seam: () => { replyTarget: (paneKey: string) => { turnId: number | null } | null } | null
): ThreadStatus {
  const status = new ThreadStatus({
    ...deps,
    runningTurn: (paneKey) => seam()?.replyTarget(paneKey)?.turnId ?? null,
    botRefused: (botId) => {
      const bots = deps.store.getBots?.()
      const bot = bots?.find((candidate) => candidate.id === botId)
      return bots !== undefined && (!bot || bot.paused)
    }
  })
  installSentConnectorCalls((path, body, result) => status.observed(path, body, result))
  installConversationWorkersWatcher(status)
  return status
}
