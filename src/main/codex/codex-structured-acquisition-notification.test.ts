import { expect, it } from 'vitest'
import { codexAcquisitionNotificationHandler } from './codex-structured-acquisition-notification'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'

it('does not revive a no-turn send when its idle thread unloads', () => {
  const echoes = createCodexDispatchEchoes()
  const notify = codexAcquisitionNotificationHandler({
    acquisition: new CodexAcquisitionWindow(),
    sessionId: 'session-1',
    dispatchEchoes: echoes,
    primaryThreadId: () => 'thread-1',
    notificationRetries: createCodexStructuredNotificationRetry({
      sessionFor: () => undefined,
      translate: () => ({ accepted: true })
    }),
    deliver: (acquisition, _sessionId, event, bytes) => {
      acquisition.buffer(event, bytes)
    },
    now: () => 0
  })
  echoes.arm('no-turn-send')
  echoes.answered('no-turn-send', echoes.tick())

  notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'active' } })
  expect([...echoes.heldSends()]).toEqual(['no-turn-send'])
  notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } })
  expect([...echoes.heldSends()]).toEqual([])
  notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'notLoaded' } })
  expect([...echoes.heldSends()]).toEqual([])
})
