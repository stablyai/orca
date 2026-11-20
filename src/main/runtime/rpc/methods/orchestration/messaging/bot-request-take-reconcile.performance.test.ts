// Perf contract (#45526 review): Orca's start decides every chat holding a question against one read
// of the restart offers, and reads few unopened chats' usage-limit cuts at once.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { reconcileBotRequestTakesAtStartup } from './bot-request-take-reconcile'

let db: OrchestrationDb
let runtime: OrcaRuntimeService

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup pass reads only the database.
  runtime = {
    getOpenOrchestrationDb: () => db,
    getExistingOrchestrationDb: () => db
  } as unknown as OrcaRuntimeService
})
afterEach(() => db.close())

function takenBy(chat: string): void {
  const admitted = db.admitBotRequest({
    rootKey: `root-${chat}`,
    fromBotId: null,
    toBotId: 'docs',
    purpose: 'question',
    depth: 1,
    record: '{}',
    debtRule: true,
    message: { from: 'orca_session_id:asker', to: `orca_session_id:${chat}`, subject: 'q' }
  })
  if (admitted.kind === 'sent') {
    db.takeBotRequest(admitted.message.id, chat, 'agent')
  }
}

it('reads the offers once and at most three unopened chats at a time', async () => {
  for (let index = 0; index < 12; index += 1) {
    takenBy(`chat-${index}`)
  }
  let offerReads = 0
  let reading = 0
  let mostAtOnce = 0
  await reconcileBotRequestTakesAtStartup(runtime, {
    readQuestionRest: async () => ({ kind: 'closed' }),
    restartHolds: async () => {
      offerReads += 1
      return new Set()
    },
    willContinue: async () => {
      reading += 1
      mostAtOnce = Math.max(mostAtOnce, reading)
      await new Promise((resolve) => setImmediate(resolve))
      reading -= 1
      // Every chat will be continued, so nothing is told and only the reads are counted.
      return true
    }
  })
  expect(offerReads).toBe(1)
  expect(mostAtOnce).toBe(3)
})
