// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { randomBytes, randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

const DEVICE_REGISTRY_FILENAME = 'orca-devices.json'

export type DeviceEntry = {
  deviceId: string
  name: string
  token: string
  pairedAt: number
  lastSeenAt: number
}

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.load()
  }

  addDevice(name: string): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: randomUUID(),
      name,
      token: randomBytes(24).toString('hex'),
      pairedAt: Date.now(),
      lastSeenAt: 0
    }
    this.devices.push(entry)
    this.save()
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(name: string): DeviceEntry {
    const existing = this.devices.find((d) => d.lastSeenAt === 0)
    if (existing) {
      return existing
    }
    return this.addDevice(name)
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
  rotatePendingDevice(name: string): DeviceEntry {
    this.devices = this.devices.filter((d) => d.lastSeenAt !== 0)
    return this.addDevice(name)
  }

  removeDevice(deviceId: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (this.devices.length < before) {
      this.save()
      return true
    }
    return false
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    return this.devices.find((d) => d.token === token) ?? null
  }

  updateLastSeen(deviceId: string): void {
    const device = this.devices.find((d) => d.deviceId === deviceId)
    if (device) {
      device.lastSeenAt = Date.now()
      this.save()
    }
  }

  private load(): void {
    if (!existsSync(this.registryPath)) {
      this.devices = []
      return
    }
    try {
      this.devices = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as DeviceEntry[]
    } catch {
      this.devices = []
    }
  }

  private save(): void {
    writeFileSync(this.registryPath, JSON.stringify(this.devices, null, 2), { mode: 0o600 })
    chmodSync(this.registryPath, 0o600)
  }
}
