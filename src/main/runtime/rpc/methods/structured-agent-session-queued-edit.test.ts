// The two in-place edit methods on the wire: registered and advertised apart from the dark
// mid-turn queue, the caller taken from the authenticated transport, strict params, and a lease
// release that cleanup admission always lets through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  QueuedMessageActionParams,
  QueuedMessageEditHoldParams,
  QueuedMessageUpdateParams
} from './structured-agent-session-schemas'

const update = {
  envelope: envelope(),
  messageId: 'card',
  expectedBodyFingerprint: 'a'.repeat(64),
  text: 'updated'
}
const acquire = {
  sessionId: SESSION,
  messageId: 'card',
  editId: 'edit',
  action: 'acquire',
  expectedBodyFingerprint: 'a'.repeat(64)
}
beforeEach(() => {
  installStructuredHostStub()
  hostCalls.queuedMessageUpdate = vi.fn(async () => ({ ok: true, value: { status: 'updated' } }))
  hostCalls.queuedMessageEditHold = vi.fn(async () => ({ status: 'held' }))
})
afterEach(clearStructuredHostStub)

describe('queued edit methods', () => {
  it('the host advertises editing on its own, with mid-turn queueing still dark', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).not.toContain(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY)
  })

  it.each([
    ['agentSession.queuedMessageUpdate', update, 'queuedMessageUpdate'],
    ['agentSession.queuedMessageEditHold', acquire, 'queuedMessageEditHold']
  ] as const)('%s reaches the host as the authenticated caller', async (method, params, name) => {
    expect(await call(method, params, STRUCTURED_CLIENT)).toMatchObject({ ok: true })
    expect(hostCalls[name]).toHaveBeenCalledWith({ callerKey: 'trusted-local:runtime' }, params)
  })

  it('a release passes cleanup admission even for an audience that cannot start this agent', async () => {
    hostCalls.sessionAgent = vi.fn(() => 'pi')
    const release = { sessionId: SESSION, messageId: 'card', editId: 'edit', action: 'release' }
    expect(
      await call('agentSession.queuedMessageEditHold', acquire, STRUCTURED_CLIENT)
    ).toMatchObject({ ok: false })
    expect(
      await call('agentSession.queuedMessageEditHold', release, STRUCTURED_CLIENT)
    ).toMatchObject({ ok: true })
  })

  it('strict params refuse a forged caller, oversized text and unknown fields', () => {
    expect(QueuedMessageUpdateParams.safeParse(update).success).toBe(true)
    expect(
      QueuedMessageUpdateParams.safeParse({ ...update, text: 'é'.repeat(256 * 1024) }).success
    ).toBe(false)
    expect(QueuedMessageUpdateParams.safeParse({ ...update, sentAs: 'goal' }).success).toBe(false)
    expect(QueuedMessageEditHoldParams.safeParse(acquire).success).toBe(true)
    expect(
      QueuedMessageEditHoldParams.safeParse({ ...acquire, callerKey: 'another-client' }).success
    ).toBe(false)
    expect(QueuedMessageEditHoldParams.safeParse({ ...acquire, action: 'renew' }).success).toBe(
      false
    )
    expect(
      QueuedMessageActionParams.safeParse({ envelope: envelope(), messageId: 'card' }).success
    ).toBe(true)
  })
})
