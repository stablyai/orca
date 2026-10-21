import { randomBytes, randomUUID } from 'node:crypto'

/** A fresh device id and its bearer token; every registry entry is minted here. */
export function mintDeviceCredential(): { deviceId: string; token: string } {
  return { deviceId: randomUUID(), token: randomBytes(24).toString('hex') }
}
