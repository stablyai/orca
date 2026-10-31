import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { RuntimeStore } from './runtime-store-contract'
import { publishNativeChatFollowUpChanges } from './runtime-native-chat-follow-up-events'

it('publishes only a change in the normalized host preference, including on a headless store', () => {
  let settings = getDefaultSettings('/tmp')
  let changed: Parameters<NonNullable<RuntimeStore['onSettingsChanged']>>[0] | undefined
  const emit = vi.fn()
  publishNativeChatFollowUpChanges(
    {
      getSettings: () => settings,
      onSettingsChanged: (listener) => {
        changed = listener
        return () => {}
      }
    },
    emit
  )
  for (const count of [10, 100]) {
    for (let index = 0; index < count; index++) {
      changed?.({}, settings)
    }
    expect(emit).not.toHaveBeenCalled()
  }
  settings = { ...settings, nativeChatQueueFollowUps: false }
  changed?.({ nativeChatQueueFollowUps: false }, settings)
  expect(emit.mock.calls).toEqual([
    [{ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false }]
  ])
  changed?.({}, settings)
  settings = { ...settings, nativeChatQueueFollowUps: true }
  changed?.({}, settings)
  expect(emit).toHaveBeenLastCalledWith({
    type: 'nativeChatQueueFollowUpsChanged',
    queueFollowUps: true
  })
  expect(emit).toHaveBeenCalledTimes(2)
})

it('client-events ready snapshots the same normalized setting after installing its event listener', async () => {
  const { OrcaRuntimeService } = await import('./orca-runtime')
  const { RuntimeClientSettingsController } = await import('./runtime-client-settings')
  const { CLIENT_EVENT_METHODS } = await import('./rpc/methods/client-events')
  const runtime = new OrcaRuntimeService()
  const settings = getDefaultSettings('/tmp')
  const controller = new RuntimeClientSettingsController({
    getSettings: () => ({ ...settings, nativeChatQueueFollowUps: false }),
    updateSettings: () => {}
  })
  const onEvent = vi.spyOn(runtime, 'onClientEvent')
  vi.spyOn(runtime, 'getClientSettings').mockImplementation(() => {
    expect(onEvent).toHaveBeenCalledTimes(1)
    return controller.get()
  })
  const ready = vi.fn()
  const handler = CLIENT_EVENT_METHODS.find(
    (method) => method.name === 'runtime.clientEvents.subscribe'
  )
  if (!handler || !('stream' in handler)) {
    throw new Error('missing client events method')
  }
  const pending = handler.handler(undefined, { runtime, connectionId: 'preference' }, ready)
  const message = ready.mock.calls.find(([value]) => value.type === 'ready')?.[0]
  expect(message).toMatchObject({
    type: 'ready',
    snapshot: { nativeChatQueueFollowUps: false }
  })
  runtime.cleanupSubscription(message.subscriptionId)
  await pending
})
