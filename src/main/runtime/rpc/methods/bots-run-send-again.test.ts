// Send again through the real native-chat host: queued by a busy chat, and clicked twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AutomationRunMessage } from '../../../../shared/automations/automation-run-message'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { sendAgentTurn } from '../../orchestration/turn-delivery/send-agent-turn'
import { botMessageBody, type BotRunFields } from '../../../bots/bot-chat-session'
import { eventually } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  RUN_ALREADY_SENT,
  sendRunAgain,
  type RunSendAgainDependencies
} from './bots-run-send-again'

const run: AutomationRunMessage = {
  runId: 'run-1',
  automation: {
    id: 'auto-1',
    name: 'Merge when green',
    enabled: true,
    nextRunAt: 20,
    updatedAt: 1,
    dtstart: 1,
    rrule: 'FREQ=DAILY',
    workspaceId: null,
    bot: { botId: 'bot-1' }
  },
  trigger: 'event',
  wait: { kind: 'event', at: 10 },
  instructionsLength: 'Merge it.'.length
}

const TEAMMATE: BotRequestAsker[] = [
  { kind: 'person', source: 'slack', userId: 'U2', workspaceId: 'T1', role: 'member' }
]

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

async function cardInChat(actsFor: readonly BotRequestAsker[]): Promise<void> {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  await open!.appendItem(
    { provider: 'orca', clientMessageId: 'automation-run-not-started:run-1' },
    {
      kind: 'automation-run-not-started',
      run,
      actsFor: [...actsFor],
      error: 'Claude Code is signed out',
      text: 'Merge it.',
      at: 10
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Sends as the bot's chats do: queued behind the chat's running turn. */
const send = vi.fn(async (text: string, fields: BotRunFields) => {
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host: rig.host,
    sessionId: SESSION,
    callerKey: 'bot-chat:bot-1',
    turn: {
      body: botMessageBody(text, fields),
      personsMessage: true,
      operationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      delivery: 'queue'
    }
  })
  expect(outcome).toMatchObject({ kind: 'queued' })
  return { sessionId: SESSION }
})

let db: OrchestrationDb

function again(host: RunSendAgainDependencies['host'] = rig.host) {
  return sendRunAgain(
    {
      host,
      claim: (runId, sessionId) => db.claimBotRunResend(runId, sessionId),
      send
    },
    { botId: 'bot-1', sessionId: SESSION, runId: 'run-1' }
  )
}

describe('sendRunAgain', () => {
  beforeEach(() => {
    send.mockClear()
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => db.close())

  it('refuses a second send whose journal read missed the first copy moving from the queue', async () => {
    const working = await rig.workingSend()
    await cardInChat(OWNER_ACTS_FOR)
    await again()
    const [draft] = await rig.drafts()
    // The journal is read before the first copy leaves the queue, the queue after it has.
    const crossing: RunSendAgainDependencies['host'] = {
      conversation: async (id) => {
        const conversation = await rig.host.conversation(id)
        const reads = conversation.journal.reads
        const runMentions: typeof reads.runMentions = async (runId) => {
          const mentions = await reads.runMentions(runId)
          await rig.settleAccepted(working, 'working')
          await eventually(async () => expect(await rig.handoff(draft!.messageId)).toBeDefined())
          const handed = await rig.handoffId(draft!.messageId)
          await eventually(async () =>
            expect((await rig.submission(handed))?.handedOverAt).toBeDefined()
          )
          await rig.settleAccepted(handed, 'retried')
          expect(await rig.drafts()).toEqual([])
          return mentions
        }
        return {
          ...conversation,
          journal: Object.assign(Object.create(conversation.journal), {
            reads: { ...reads, runMentions }
          })
        }
      }
    }

    await expect(again(crossing)).rejects.toThrow(RUN_ALREADY_SENT)
    expect(send).toHaveBeenCalledOnce()
  })

  it('sends a run once, though the first copy still waits in the queue and the owner clicks twice', async () => {
    await rig.workingSend()
    await cardInChat(OWNER_ACTS_FOR)

    const [first, second] = await Promise.allSettled([again(), again()])
    await expect(again()).rejects.toThrow(RUN_ALREADY_SENT)

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(send).toHaveBeenCalledOnce()
  })

  it('sends again a run an older host recorded for a teammate, in a chat that acts for the owner', async () => {
    await rig.workingSend()
    await cardInChat(TEAMMATE)

    await expect(again()).resolves.toEqual({ sessionId: SESSION })
    expect(send).toHaveBeenCalledOnce()
  })
})
