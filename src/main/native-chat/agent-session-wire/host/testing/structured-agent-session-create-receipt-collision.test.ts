import { expect, it } from 'vitest'
import { createRestTestRig } from './structured-agent-session-rest-test-rig.test-fixture'
import { claudeProfileSetupFailed } from '../../../../claude-accounts/profiles/routing/claude-profile-launch-errors'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from './structured-agent-session-create.test-fixture'
import {
  hostTestMessage,
  hostTestOperationId,
  hostTestAttachParams
} from './structured-agent-session-host-test-data.test-fixture'

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

it('returns a typed preparation failure on its first response and replay, then permits recovery', async () => {
  const rig = await createRestTestRig()
  try {
    rig.adapter.acquire.mockRejectedValueOnce(claudeProfileSetupFailed())
    const params = hostTestAttachParams(null)
    const first = await rig.host.attach(CREATE_TEST_CALLER, params)
    expect(first).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'claudeAccountSetupFailed', ownerVerdict: 'exited' },
        ownerVerdict: 'exited'
      }
    })
    await expect(rig.host.attach(CREATE_TEST_CALLER, params)).resolves.toEqual(first)
    await expect(
      rig.host.attach(CREATE_TEST_CALLER, hostTestAttachParams(null))
    ).resolves.toMatchObject({ ok: true })
  } finally {
    await rig.dispose()
  }
})
