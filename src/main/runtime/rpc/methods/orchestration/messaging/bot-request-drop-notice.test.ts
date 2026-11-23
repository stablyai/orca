import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { dropUnreadBotRequests } from './bot-request-outcome'
import { installSenderHost, removeSenderHost } from './bot-request-sender-host.test-fixture'

const SENDER_ID = '11111111-1111-4111-8111-111111111111'
const SENDER = `orca_session_id:${SENDER_ID}`

describe('a dropped bot request tells its sender', () => {
  let db: OrchestrationDb
  let requestId: string
  let install: () => void

  function runtime(): OrcaRuntimeService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the drop path reads only these members.
    return {
      getOrchestrationDb: () => db,
      notifyMessageArrived: () => {},
      getLiveTerminalPaneKey: () => null,
      ensureStructuredAgentSessionHost: async () => install()
    } as unknown as OrcaRuntimeService
  }
  const notices = () =>
    db.getAllMessagesForHandle(SENDER).filter((message) => message.from_handle !== SENDER)

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    install = () => {}
    const sent = db.admitBotRequest({
      rootKey: 'root',
      fromBotId: 'sender',
      toBotId: 'receiver',
      purpose: 'handoff',
      depth: 1,
      record: JSON.stringify({
        fromBotId: 'sender',
        fromBotName: 'Sender',
        toBotId: 'receiver',
        toBotName: 'Receiver',
        purpose: 'handoff',
        depth: 1,
        askers: [{ kind: 'owner' }],
        request: 'work',
        conversation: null
      }),
      message: {
        from: SENDER,
        to: 'orca_session_id:22222222-2222-4222-8222-222222222222',
        subject: 'work',
        type: 'handoff'
      }
    })
    if (sent.kind !== 'sent') {
      throw new Error(sent.kind)
    }
    requestId = sent.message.id
  })
  afterEach(() => {
    removeSenderHost()
    db.close()
  })

  it('installs the session records first, so a sender a restart left unloaded still hears', async () => {
    install = () => installSenderHost([SENDER_ID])
    await dropUnreadBotRequests(runtime(), 'receiver', 'paused')
    expect(notices()).toHaveLength(1)
    expect(db.getBotRequestOutcome(requestId)).toBe('dropped')
    expect(db.listUnreadBotRequests('receiver')).toHaveLength(0)
  })

  it('keeps the request when its sender cannot be verified yet, and tells it once it can', async () => {
    await dropUnreadBotRequests(runtime(), 'receiver', 'paused')
    expect(notices()).toHaveLength(0)
    expect(db.getBotRequestOutcome(requestId)).toBeNull()
    expect(db.listUnreadBotRequests('receiver')).toHaveLength(1)

    install = () => installSenderHost([SENDER_ID])
    await dropUnreadBotRequests(runtime(), 'receiver', 'paused')
    expect(notices()).toHaveLength(1)
    expect(db.getBotRequestOutcome(requestId)).toBe('dropped')
  })

  it('drops the request without a notice when its sender is proven gone', async () => {
    install = () => installSenderHost([])
    await dropUnreadBotRequests(runtime(), 'receiver', 'deleted')
    expect(notices()).toHaveLength(0)
    expect(db.getBotRequestOutcome(requestId)).toBe('dropped')
    expect(db.listUnreadBotRequests('receiver')).toHaveLength(0)
  })
})
