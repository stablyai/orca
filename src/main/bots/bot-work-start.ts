// Records a worker a bot started, under the conversation or chat its turn came from.
import type { Bot } from '../../shared/bot-types'
import { botOfHome } from './bot-home-membership'
import type { BotTurnAddress, BotWorkRecord } from './bot-work-record'
import type { BotWorkHost } from './bot-work-store'

/** Reads which conversation a bot's turn is when a worker start begins, so a message arriving while
 *  it starts can't move it; records the worker once it started. A turn no connector conversation
 *  named (Home, any other chat, a group room, an automation run) records under the chat itself. */
export function prepareBotWorkerStart(
  runtime: {
    bots: { list: () => readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[] }
    botWork: Pick<BotWorkRecord, 'turnOf' | 'started'>
    /** 'local', or the paired server a Dispatch runs on. */
    hostOf: (dispatchId: string) => BotWorkHost
  },
  callerSession: { sessionId: string; workspaceId: string } | undefined
): (start: { taskId: string; dispatchId: string }) => void {
  const turn = Promise.resolve()
    .then(async (): Promise<BotTurnAddress | null> => {
      const bot = botOfHome(runtime.bots, callerSession)
      if (!bot || !callerSession) {
        return null
      }
      return (
        (await runtime.botWork.turnOf(callerSession.sessionId)) ?? {
          botId: bot.id,
          address: { source: 'chat', externalId: callerSession.sessionId },
          askedInApp: true
        }
      )
    })
    .catch(warnUnrecorded)
  return ({ taskId, dispatchId }) => {
    void turn
      .then(async (address) => {
        if (address) {
          const host = runtime.hostOf(dispatchId)
          await runtime.botWork.started(address, { taskId, dispatchId, host })
        }
      })
      .catch(warnUnrecorded)
  }
}

function warnUnrecorded(error: unknown): null {
  console.warn('[bots] recording a bot worker failed', error)
  return null
}
