import { expect, it } from 'vitest'
import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from './structured-agent-session-create-test-fixture'
import { hostTestMessage, hostTestOperationId } from './structured-agent-session-host-test-data'

it('refuses a reused opening message ID without creating the second session', async () => {
  const rig = await createRestTestRig()
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('Hello') }
    expect(
      await rig.host.create(CREATE_TEST_CALLER, createTestParams(firstMessage), { firstMessage })
    ).toMatchObject({ ok: true })

    const second = createTestParams(firstMessage, {}, 'session-second')
    expect(await rig.host.create(CREATE_TEST_CALLER, second, { firstMessage })).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'messageIdReused' } }
    })
    expect(rig.store.getRecord('session-second')).toBeNull()
  } finally {
    await rig.dispose()
  }
})
