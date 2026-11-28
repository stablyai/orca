import { describe, expect, it, vi } from 'vitest'
import type { ConnectionVerdict } from '../../../transport/connection/connection-health'
import { mobileNativeChatHostOutage } from './mobile-native-chat-host-outage'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

function outage(pairedVerdict: ConnectionVerdict, reconnect: (() => void) | null = null) {
  return mobileNativeChatHostOutage({
    pairedHostState: 'reconnecting',
    pairedVerdict,
    hostName: 'Work laptop',
    reconnect
  })
}

describe('mobileNativeChatHostOutage', () => {
  it('says offline only when Relay reported the desktop offline', () => {
    expect(
      outage({
        kind: 'unreachable',
        label: 'Work laptop is offline',
        reason: 'stale',
        relay: 'host-offline'
      })?.text
    ).toBe('Work laptop is offline')
  })

  it('keeps the Relay diagnosis for a signed-out desktop or an unreachable Relay', () => {
    const retry = vi.fn()
    const signedOut = outage(
      {
        kind: 'unreachable',
        label: 'Sign-in required on Work laptop',
        reason: 'stale',
        relay: 'signed-out'
      },
      retry
    )
    expect(signedOut).toEqual({ text: 'Sign-in required on Work laptop', onReconnect: retry })
    expect(outage({ kind: 'warning', label: "Can't reach Relay", relay: 'unreachable' })).toEqual({
      text: "Can't reach Relay"
    })
    expect(
      outage({
        kind: 'unreachable',
        label: 'Relay refused access for Work laptop',
        reason: 'stale',
        relay: 'credential-refused'
      })?.text
    ).toBe('Relay refused access for Work laptop')
  })

  it('keeps the offline wording for a direct outage with no Relay evidence', () => {
    expect(
      outage({ kind: 'unreachable', label: "Can't reach desktop", reason: 'stale' })?.text
    ).toBe('Work laptop is offline')
  })
})
