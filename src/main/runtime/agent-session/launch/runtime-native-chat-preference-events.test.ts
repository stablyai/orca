import { expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeClientSettingsController } from '../../client/settings/runtime-client-settings'
import { publishNativeChatPreferenceChanges } from './runtime-native-chat-preference-events'
import { eraseRpcMethods, isStreamingMethod } from '../../rpc/core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from '../../rpc/methods/rpc-method-registry'

function settingsStore(initial: Partial<GlobalSettings>) {
  let settings: GlobalSettings = { ...getDefaultSettings('/tmp'), ...initial }
  const listeners: ((updates: Partial<GlobalSettings>, settings: GlobalSettings) => void)[] = []
  return {
    getSettings: () => settings,
    onSettingsChanged: (
      listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
    ) => {
      listeners.push(listener)
      return () => {}
    },
    update: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      listeners.forEach((listener) => listener(updates, settings))
    }
  }
}

it('pushes each chat preference only when its own resolved value flips', () => {
  const store = settingsStore({ nativeChatQueueFollowUps: true })
  const events: RuntimeClientEvent[] = []
  publishNativeChatPreferenceChanges(store, (event) => events.push(event))

  store.update({ nativeChatCiResultLines: false })
  store.update({ nativeChatQueueFollowUps: false })
  store.update({ nativeChatCiResultLines: false, nativeChatQueueFollowUps: false })
  store.update({ nativeChatCiResultLines: true })

  expect(events).toEqual([
    { type: 'nativeChatCiResultLinesChanged', ciResultLines: false },
    { type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false },
    { type: 'nativeChatCiResultLinesChanged', ciResultLines: true }
  ])
})

it('resolves the CI result lines setting in the ready snapshot', async () => {
  const subscribe = eraseRpcMethods(ALL_RPC_METHODS)
    .filter(isStreamingMethod)
    .find((method) => method.name === 'runtime.clientEvents.subscribe')!
  const snapshots: unknown[] = []
  const cleanups: (() => void)[] = []
  const streams: Promise<unknown>[] = []
  for (const saved of [{}, { nativeChatCiResultLines: false }]) {
    const settings = new RuntimeClientSettingsController(settingsStore(saved))
    const fake = {
      getRuntimeId: () => 'runtime-a',
      onClientEvent: () => () => {},
      getClientSettings: () => settings.get(),
      registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
        cleanups.push(cleanup)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscribe handler reads only these members.
    const runtime = fake as unknown as OrcaRuntimeService
    streams.push(
      subscribe.handler({}, { runtime, connectionId: 'conn-1' }, (event) => {
        if (event && typeof event === 'object' && 'snapshot' in event) {
          snapshots.push(event.snapshot)
        }
      })
    )
  }
  cleanups.forEach((cleanup) => cleanup())
  await Promise.all(streams)
  expect(snapshots).toEqual([
    expect.objectContaining({ nativeChatCiResultLines: true }),
    expect.objectContaining({ nativeChatCiResultLines: false })
  ])
})
