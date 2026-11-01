import './unused-default-rpc-methods.test-fixture'
import { expect, it } from 'vitest'
import { GeneratedAgentInputNotices } from '../generated-agent-input-notices'
import { CLIENT_EVENT_METHODS } from './methods/client-events'
import type { RpcContext } from './core'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

it('snapshots disconnected refusals and synchronizes an idempotent dismissal from another client', async () => {
  const listeners = new Set<(event: RuntimeClientEvent) => void>()
  const notices = new GeneratedAgentInputNotices((records) => {
    for (const listener of listeners) {
      listener({ type: 'generatedInputNoticesChanged', notices: records })
    }
  })
  const cleanups = new Map<string, () => void>()
  const runtime = {
    generatedInputNotices: notices,
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    getClientSettings: () => ({ nativeChatQueueFollowUps: false })
  }
  // SAFETY: these handlers only consume the client-event and notice methods provided above.
  const context = { runtime, connectionId: 'viewer' } as unknown as RpcContext
  const subscribe = CLIENT_EVENT_METHODS.find(
    (method) => method.name === 'runtime.clientEvents.subscribe'
  )
  const dismiss = CLIENT_EVENT_METHODS.find(
    (method) => method.name === 'terminal.dismissGeneratedInputNotice'
  )
  if (!subscribe || !('stream' in subscribe) || !dismiss || 'stream' in dismiss) {
    throw new Error('missing methods')
  }
  expect(dismiss.permission).toBe('workspace')
  const first: unknown[] = []
  const firstDone = subscribe.handler(null, context, (event) => first.push(event))
  expect(listeners.size).toBe(1)
  for (const cleanup of cleanups.values()) {
    cleanup()
  }
  cleanups.clear()
  await firstDone
  notices.add({
    agent: 'claude',
    text: 'exact\ntext',
    handle: 'closed-pane',
    worktreeId: 'worktree',
    ptyId: 'gone',
    certainty: 'not-sent'
  })
  const [record] = notices.snapshot()
  const a: unknown[] = []
  const b: unknown[] = []
  const aDone = subscribe.handler(null, context, (event) => a.push(event))
  const bDone = subscribe.handler(null, { ...context, connectionId: 'other' }, (event) =>
    b.push(event)
  )
  for (const events of [a, b]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ready',
        snapshot: expect.objectContaining({ generatedInputNotices: [record] })
      })
    )
  }
  await dismiss.handler({ id: record.id }, context)
  await dismiss.handler({ id: record.id }, context)
  for (const events of [a, b]) {
    expect(events.at(-1)).toEqual({ type: 'generatedInputNoticesChanged', notices: [] })
  }
  expect(notices.snapshot()).toEqual([])
  for (const cleanup of cleanups.values()) {
    cleanup()
  }
  await Promise.all([aDone, bDone])
})
