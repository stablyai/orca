import { randomBytes, randomUUID } from 'node:crypto'

export function mintDeviceCredential(): { deviceId: string; token: string } {
  return { deviceId: randomUUID(), token: randomBytes(24).toString('hex') }
}
