import { afterEach, describe, expect, it } from 'vitest'
import {
  drivingDeviceFor,
  resetDrivingDevices,
  terminalSenderKey
} from '../../../sender/driving-device-registry'
import { recordTypingDevice } from './terminal-multiplex-input-frame'

afterEach(() => resetDrivingDevices())

describe('typing in a terminal drives it (git as the sender in plain terminals)', () => {
  it('records the paired device that typed, so orca sender answers for a plain terminal', () => {
    recordTypingDevice('term_plain', 'dev-alice')
    expect(drivingDeviceFor(terminalSenderKey('term_plain'))).toMatchObject({
      deviceId: 'dev-alice'
    })
  })

  it('the last person to type wins in a shared terminal', () => {
    recordTypingDevice('term_shared', 'dev-alice')
    recordTypingDevice('term_shared', 'dev-bob')
    expect(drivingDeviceFor(terminalSenderKey('term_shared'))?.deviceId).toBe('dev-bob')
  })

  it('a connection without a paired device (local window) never records', () => {
    recordTypingDevice('term_local', undefined)
    expect(drivingDeviceFor(terminalSenderKey('term_local'))).toBeNull()
  })
})
