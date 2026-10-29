import type { MobileQueuedEditHostFixtureModule } from '../../../shared/mobile-queued-edit-host.test-fixture-contract'
import {
  QueuedMessageEditHoldParams,
  QueuedMessageUpdateParams
} from '../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW, HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

export { HOST_TEST_NOW as now }

// Keep the real host checked with Node globals; the phone compiler checks the fixture contract.
export const createMobileQueuedEditHostFixture: MobileQueuedEditHostFixtureModule['createMobileQueuedEditHostFixture'] =
  async () => {
    const rig = await createQueuedMessageTestRig()
    const journal = () => rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    return {
      sessionId: HOST_TEST_SESSION,
      start: rig.workingSend,
      insert: (input) => journal().queuedMessages.insert(input),
      read: (messageId) => journal().queuedMessages.get(messageId),
      published: async (messageId) => {
        const result = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
        const row = result.ok
          ? result.page.queuedMessages?.find((entry) => entry.messageId === messageId)
          : undefined
        if (!row) {
          throw new Error('missing published queued message')
        }
        return row
      },
      request: async (method, params) => {
        if (method === 'agentSession.queuedMessageEditHold') {
          return rig.host.queuedMessageEditHold(
            QUEUED_RIG_CALLER,
            QueuedMessageEditHoldParams.parse(params)
          )
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          throw new Error('unexpected host fixture request')
        }
        const { envelope, ...fields } = QueuedMessageUpdateParams.parse(params)
        return rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
          ...fields,
          envelope: rig.envelope(fields, method, envelope.clientOperationId)
        })
      },
      restart: async () => {
        await rig.restartHostProcess()
        await rig.drafts()
      },
      dispose: rig.dispose
    }
  }
