import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionStatusState } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-status-journal-projection'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { botQuestionNotices } from './bot-question-notices'

describe('a bot question whose taker asks a person', () => {
  let db: OrchestrationDb
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'answer the question',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
  })
  afterEach(() => db.close())

  it('tells the asker to wait instead of saying the taker ended without an answer', async () => {
    const record: BotRequestRecord = {
      fromBotId: 'bot-a',
      fromBotName: 'A',
      toBotId: 'bot-b',
      toBotName: 'B',
      purpose: 'question',
      depth: 1,
      askers: [{ kind: 'owner' }],
      request: null,
      conversation: null
    }
    const admitted = db.admitBotRequest({
      rootKey: 'question',
      fromBotId: 'bot-a',
      toBotId: 'bot-b',
      purpose: 'question',
      depth: 1,
      record: JSON.stringify(record),
      message: {
        from: `run:${runId}`,
        to: 'orca_session_id:taker',
        subject: 'Question',
        type: 'question',
        runId
      }
    })
    if (admitted.kind !== 'sent') {
      throw new Error(`not admitted: ${admitted.kind}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: noticeWords reads only these fields.
    const state = {
      latestRequest: {
        kind: 'turn',
        id: 'turn-b',
        turnState: 'running',
        outcome: null,
        settledAt: undefined
      },
      owesWork: false,
      goalContinues: false,
      pendingPromptIds: ['prompt-person'],
      summary: { status: 'attention' }
    } as unknown as StructuredAgentSessionStatusState
    const notifyMessageArrived = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the stubbed members.
    const runtime = {
      getOrchestrationDb: () => db,
      notifyMessageArrived
    } as unknown as OrcaRuntimeService

    const write = await botQuestionNotices(
      runtime,
      'session:taker',
      [admitted.message.id],
      async () => state
    )
    expect(write({ messageId: admitted.message.id, taker: 'session:taker', kind: 'bot' })).toBe(
      'told'
    )

    const [notice] = db.getAllMessages(`run:${runId}`)
    expect(notice?.body).toContain("B is waiting on a person's reply")
    expect(notice?.body).not.toContain('ended its turn')
  })
})
