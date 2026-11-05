import { describe, expect, it } from 'vitest'
import { mobileNativeChatHostOutage } from './mobile-native-chat-host-outage'

const connected = { kind: 'normal', label: 'Connected' } as const
const reconnect = (): void => {}
const unreachable = { kind: 'unreachable', label: 'Unreachable', reason: 'stale' } as const

describe('mobileNativeChatHostOutage', () => {
  it.each([
    [
      'an offline desktop offers Reconnect',
      { pairedHostState: 'reconnecting', pairedVerdict: unreachable, reconnect },
      { text: 'connection.connectionHealth.hostOffline', onReconnect: reconnect }
    ],
    [
      'a desktop still retrying offers nothing yet',
      {
        pairedHostState: 'reconnecting',
        pairedVerdict: { kind: 'normal', label: 'Reconnecting…', dialing: true },
        reconnect: null
      },
      { text: 'chat.hostOutage.reconnecting' }
    ],
    [
      'a stopped server distro is text only',
      {
        pairedHostState: 'connected',
        pairedVerdict: connected,
        reconnect,
        server: { state: 'connecting', name: 'Ubuntu', desktopReach: 'stopped' }
      },
      { text: 'chat.hostOutage.stopped' }
    ],
    [
      'a server the desktop has not brought up points at the computer',
      {
        pairedHostState: 'connected',
        pairedVerdict: connected,
        reconnect,
        server: { state: 'connecting', name: 'Ubuntu', desktopReach: 'unavailable' }
      },
      { text: 'chat.hostOutage.unavailable' }
    ],
    [
      'an offline server cannot be redialled from the phone',
      {
        pairedHostState: 'connected',
        pairedVerdict: connected,
        reconnect,
        server: { state: 'disconnected', name: 'Build box' }
      },
      { text: 'connection.connectionHealth.hostOffline' }
    ]
  ] as const)('%s', (_name, args, expected) => {
    // Why keys: the test pins which message and action each outage gets, not its wording.
    expect(mobileNativeChatHostOutage({ hostName: 'Studio Mac', ...args }, (key) => key)).toEqual(
      expected
    )
  })
})
