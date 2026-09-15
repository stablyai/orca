import { expect, it } from 'vitest'
import { PushDeviceRegistrationRequestSchema } from './device-registration-messages.js'

const registration = (token: string) => ({
  v: 1,
  deviceId: 'qa-device',
  platform: 'ios',
  token,
  apnsEnvironment: 'sandbox'
})

it.each([32, 64, 160, 256])(
  'accepts variable-length APNs device tokens (%i hex characters)',
  (length) => {
    expect(
      PushDeviceRegistrationRequestSchema.safeParse(registration('aB'.repeat(length / 2))).success
    ).toBe(true)
  }
)

it.each(['', 'abc', 'not-hex', 'ab cd', 'ab'.repeat(2049)])(
  'rejects malformed or oversized APNs tokens',
  (token) => {
    expect(PushDeviceRegistrationRequestSchema.safeParse(registration(token)).success).toBe(false)
  }
)
