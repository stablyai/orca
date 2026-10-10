import { describe, expect, it } from 'vitest'
import {
  pickVoiceSettingsClient,
  resolveVoiceSettingsHostScope
} from './voice-settings-host-selection'

const clients = [
  { hostId: 'a', state: 'connected', client: 'client-a' },
  { hostId: 'b', state: 'connecting', client: 'client-b' }
]

describe('voice settings host selection', () => {
  it('falls back to the first connected host when no host is named', () => {
    expect(resolveVoiceSettingsHostScope(['a', 'b'], undefined)).toEqual({
      hostIds: ['a', 'b'],
      scopedHostId: undefined,
      unpaired: false
    })
    expect(pickVoiceSettingsClient(clients, undefined)).toBe('client-a')
  })

  it('waits for the named host instead of configuring another desktop', () => {
    expect(resolveVoiceSettingsHostScope(['a', 'b'], 'b')).toEqual({
      hostIds: ['b'],
      scopedHostId: 'b',
      unpaired: false
    })
    expect(pickVoiceSettingsClient(clients, 'b')).toBeNull()
    const bConnected = [clients[0], { ...clients[1], state: 'connected' }]
    expect(pickVoiceSettingsClient(bConnected, 'b')).toBe('client-b')
  })

  it('connects nowhere while the paired hosts are still loading', () => {
    const scope = resolveVoiceSettingsHostScope(null, 'b')
    expect(scope).toEqual({ hostIds: [], scopedHostId: 'b', unpaired: false })
    expect(pickVoiceSettingsClient(clients, scope.scopedHostId)).toBeNull()
  })

  it('never falls back to another desktop when the named host is no longer paired', () => {
    const scope = resolveVoiceSettingsHostScope(['a'], 'gone')
    expect(scope).toEqual({ hostIds: [], scopedHostId: 'gone', unpaired: true })
    expect(pickVoiceSettingsClient(clients, scope.scopedHostId)).toBeNull()
  })
})
