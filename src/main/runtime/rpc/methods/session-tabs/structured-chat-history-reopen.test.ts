import { expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { HOST_TEST_SESSION } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { call, createChat, snapshot, WORKTREE } from './structured-chat-tab-table.test-fixture'

it('keeps the chat reopened from desktop history when a paired close targets its old tab', async () => {
  await createChat(HOST_TEST_SESSION)
  const phone = {
    pairedDeviceId: 'phone-a',
    clientKind: 'mobile' as const,
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  }
  const close = (tabId: string, pairedDeviceId = phone.pairedDeviceId) =>
    call(
      'session.tabs.close',
      { worktree: WORKTREE, tabId, reason: 'user' },
      {
        ...phone,
        pairedDeviceId
      }
    )
  const reveal = () => call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
  const tabId = async () => {
    const tabs = (await snapshot()).tabs.filter((tab) => tab.type === 'agent-session')
    expect(tabs.map((tab) => tab.sessionId)).toEqual([HOST_TEST_SESSION])
    return tabs[0].id
  }

  const original = await tabId()
  expect(await close(original, 'phone-b')).toMatchObject({ ok: true, result: { closed: true } })
  expect(await reveal()).toMatchObject({ ok: true, result: { ok: true } })
  const firstReopen = await tabId()
  expect(await close(original)).toMatchObject({ ok: false, error: { message: 'tab_not_found' } })
  expect(await tabId()).toBe(firstReopen)

  expect(await close(firstReopen, 'phone-b')).toMatchObject({ ok: true, result: { closed: true } })
  expect(await reveal()).toMatchObject({ ok: true, result: { ok: true } })
  const current = await tabId()
  expect(await close(firstReopen)).toMatchObject({
    ok: false,
    error: { message: 'tab_not_found' }
  })
  expect(await reveal()).toMatchObject({ ok: true, result: { ok: true } })
  expect(await tabId()).toBe(current)
  expect(await close(current)).toMatchObject({ ok: true, result: { closed: true } })
  expect((await snapshot()).tabs).toEqual([])
})
