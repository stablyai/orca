import { expect, it } from 'vitest'
import { isWithheldOpeningMessage } from '../../acquisition/structured-agent-session-opening-withdrawal'
import { createRestTestRig } from './structured-agent-session-rest-test-rig.test-fixture'
import { claudeProfileSetupFailed } from '../../../../claude-accounts/profiles/routing/claude-profile-launch-errors'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from './structured-agent-session-create.test-fixture'
import {
  hostTestMessage,
  hostTestOperationId,
  hostTestAttachParams,
  HOST_TEST_SESSION
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

it('rejects a background launch after asynchronous preparation without submitting its message', async () => {
  const rig = await createRestTestRig()
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('Hello') }
    const prepared = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    rig.host.deps.resolveLaunchEnv = async () => {
      prepared.resolve()
      await resume.promise
      return {}
    }
    let settled = true
    const refused = new Error('machine_unsettled')
    const create = rig.host.create(CREATE_TEST_CALLER, createTestParams(firstMessage), {
      firstMessage,
      beforeFirstMessage: () => {
        if (!settled) {
          throw refused
        }
      }
    })
    const rejected = expect(create).rejects.toBe(refused)
    await prepared.promise
    settled = false
    resume.resolve()
    await rejected
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    expect(rig.store.getRecord(HOST_TEST_SESSION)).toBeNull()
  } finally {
    await rig.dispose()
  }
})

it('waits for an asynchronous opening-message check and sends nothing when it refuses', async () => {
  const rig = await createRestTestRig()
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('Hello') }
    const refused = new Error('not_full_wake')
    const create = rig.host.create(CREATE_TEST_CALLER, createTestParams(firstMessage), {
      firstMessage,
      beforeFirstMessage: async () => {
        // A fresh system-state read resolves later than the call; then it refuses.
        await Promise.resolve()
        throw refused
      }
    })
    await expect(create).rejects.toBe(refused)
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    expect(rig.store.getRecord(HOST_TEST_SESSION)).toBeNull()
  } finally {
    await rig.dispose()
  }
})

it('withdraws an opening message its caller refuses at delivery, after the last await', async () => {
  const rig = await createRestTestRig()
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('Hello') }
    let stillOwned = true
    const created = await rig.host.create(CREATE_TEST_CALLER, createTestParams(firstMessage), {
      firstMessage,
      // The last await before the chat is registered: the caller gives the run up during it.
      publishTab: async () => {
        stillOwned = false
      },
      beforeDelivery: () => stillOwned
    })
    expect(created.ok && created.value.firstMessage?.dispatchState).toBe('rejected')
    expect(isWithheldOpeningMessage(firstMessage.clientMessageId)).toBe(true)
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})

it('refuses an opening message whose delivery check throws', async () => {
  const rig = await createRestTestRig()
  try {
    const firstMessage = { clientMessageId: hostTestOperationId(), body: hostTestMessage('Hello') }
    const created = await rig.host.create(CREATE_TEST_CALLER, createTestParams(firstMessage), {
      firstMessage,
      beforeDelivery: () => {
        throw new Error('store unreadable')
      }
    })
    expect(created.ok && created.value.firstMessage?.dispatchState).toBe('rejected')
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})
