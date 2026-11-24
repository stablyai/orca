// Devices of teammates the owner shared one bot with: each signs in with its own device key and reaches
// that bot's chats only. Kept apart from the device registry, which reads an unknown scope as a phone,
// so an older build never sees these rows and refuses them.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DeviceScope } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isDevicePublicKeyB64 } from '../../../../../shared/remote-runtime/pairing/device-key-proof'
import {
  hardenExistingSecureFile,
  isUnreadableError
} from '../../../../../shared/secure-storage/secure-file'
import { writeSecureFileAsync } from '../../../../../shared/secure-storage/secure-file-async-write'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import { isMissingFileError, quarantineCorruptRegistry } from './device-registry-corruption'
import { validRelayBinding } from './device-registry-row-validation'
import { BOT_SHARE_DEVICES_FILENAME } from './mobile-pairing-files'

export type BotShareGrant = { botId: string; accountId: string; name: string }

/** Whether the share a row stands on is still on the bot's list; a row without one signs in as nothing. */
export type BotShareGranted = (grant: Pick<BotShareGrant, 'botId' | 'accountId'>) => boolean

export type BotShareDevice = BotShareGrant & {
  deviceId: string
  /** `runtime`: the teammate's desktop; `mobile`: a phone that desktop provisioned (`parentDeviceId`). */
  scope: DeviceScope
  devicePublicKeyB64: string
  pairedAt: number
  relayBinding?: RelayDeviceBinding
  parentDeviceId?: string
  /** A phone's: the share its credential was installed with Orca Cloud under, to remove it there. */
  shareId?: string
}

export type BotShareDeviceLookup =
  | { kind: 'found'; device: BotShareDevice }
  | { kind: 'unknown' }
  // Its parent is gone: revoked with it, but not yet removed.
  | { kind: 'refused' }
  // The file can't be read (or wasn't whole), which proves nothing absent.
  | { kind: 'unavailable' }

const NonEmpty = z.string().min(1)
const BotShareDeviceRow = z.looseObject({
  deviceId: NonEmpty,
  botId: NonEmpty,
  accountId: NonEmpty,
  name: z.string(),
  scope: z.enum(['runtime', 'mobile']),
  devicePublicKeyB64: z.string().refine(isDevicePublicKeyB64),
  pairedAt: z.number().finite(),
  relayBinding: z.unknown().optional(),
  parentDeviceId: NonEmpty.optional(),
  shareId: NonEmpty.optional()
})
const BotShareDevicesFile = z.object({ v: z.literal(1), devices: z.array(z.unknown()) })

/** A row is used only whole; one that fails its schema is refused, never read as anything else. */
function parseRow(value: unknown): BotShareDevice | null {
  const row = BotShareDeviceRow.safeParse(value)
  if (!row.success) {
    return null
  }
  const { relayBinding, ...rest } = row.data
  const binding = validRelayBinding(relayBinding, rest.deviceId)
  return binding ? { ...rest, relayBinding: binding } : rest
}

export class BotShareDeviceStore {
  private readonly path: string
  private devices: BotShareDevice[] = []
  /** Never overwrite a file that couldn't be read: that would revoke every share device. */
  private unreadable = false
  /** Rows were refused or the file was corrupt: a missing device may be one of them. */
  private doubtful = false
  /** Rows this build couldn't read, written back as they were: they may be another build's devices. */
  private unparsedRows: unknown[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(
    userDataPath: string,
    private readonly granted: BotShareGranted
  ) {
    this.path = join(userDataPath, BOT_SHARE_DEVICES_FILENAME)
    this.load()
  }

  list(): readonly BotShareDevice[] {
    return this.devices
  }

  get(deviceId: string): BotShareDevice | null {
    return this.devices.find((device) => device.deviceId === deviceId) ?? null
  }

  lookupDeviceKey(deviceId: string): BotShareDeviceLookup {
    if (this.unreadable) {
      return { kind: 'unavailable' }
    }
    const device = this.get(deviceId)
    if (!device) {
      // A client erases its key on unknown, so only a whole read may say so.
      return this.doubtful ? { kind: 'unavailable' } : { kind: 'unknown' }
    }
    return this.signsIn(device) ? { kind: 'found', device } : { kind: 'refused' }
  }

  /** A signed-in socket's row as it is now: gone, or no longer the same grant, refuses it. */
  resolveAuthenticatedPrincipal(deviceId: string, grant: BotShareGrant): BotShareDevice | null {
    const device = this.get(deviceId)
    return device &&
      device.botId === grant.botId &&
      device.accountId === grant.accountId &&
      this.signsIn(device)
      ? device
      : null
  }

  async add(input: Omit<BotShareDevice, 'deviceId' | 'pairedAt'>): Promise<BotShareDevice> {
    return (await this.findOrAdd(() => false, input)).device
  }

  /** The row `match` finds, else a new one from `input` (`added`), in one turn of the write queue,
   *  so concurrent asks for the same device never make two rows. */
  async findOrAdd(
    match: (device: BotShareDevice) => boolean,
    input: Omit<BotShareDevice, 'deviceId' | 'pairedAt'>
  ): Promise<{ device: BotShareDevice; added: boolean }> {
    let found: BotShareDevice | undefined
    let added: BotShareDevice | undefined
    await this.save((devices) => {
      found = devices.find(match)
      if (found) {
        return null
      }
      added = { ...input, deviceId: randomUUID(), pairedAt: Date.now() }
      return [...devices, added]
    })
    const device = found ?? added
    if (!device) {
      throw new Error('share_device_not_saved')
    }
    return { device, added: added !== undefined }
  }

  /** The devices `roots` names and every phone provisioned under them, children first. */
  withChildren(roots: readonly BotShareDevice[]): BotShareDevice[] {
    const plan: BotShareDevice[] = []
    const visit = (device: BotShareDevice): void => {
      if (plan.includes(device)) {
        return
      }
      this.devices.filter((child) => child.parentDeviceId === device.deviceId).forEach(visit)
      plan.push(device)
    }
    roots.forEach(visit)
    return plan
  }

  async remove(deviceId: string): Promise<void> {
    await this.save((devices) => devices.filter((device) => device.deviceId !== deviceId))
  }

  async setRelayBinding(deviceId: string, binding: RelayDeviceBinding): Promise<boolean> {
    let bound = false
    await this.save((devices) =>
      devices.map((device) => {
        if (device.deviceId !== deviceId || binding.relayDeviceId !== deviceId) {
          return device
        }
        bound = true
        return { ...device, relayBinding: binding }
      })
    )
    return bound
  }

  /** Its parent row is still here and its share still on the bot's list: a removed teammate's
   *  leftover row (a revoke that failed or raced an accept) refuses every frame and reconnect. */
  private signsIn(device: BotShareDevice): boolean {
    return (
      (device.parentDeviceId === undefined || this.get(device.parentDeviceId) !== null) &&
      this.granted(device)
    )
  }

  private load(): void {
    try {
      hardenExistingSecureFile(this.path)
      const file = BotShareDevicesFile.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')))
      if (!file.success) {
        throw new Error('Share device file has an unknown shape')
      }
      this.devices = []
      for (const row of file.data.devices) {
        const device = parseRow(row)
        if (device) {
          this.devices.push(device)
        } else {
          this.unparsedRows.push(row)
        }
      }
      if (this.unparsedRows.length > 0) {
        this.doubtful = true
        console.error('[runtime] Refused unreadable share device rows')
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      this.unreadable = isUnreadableError(error)
      this.doubtful = true
      console.error('[runtime] Failed to read share devices:', error)
      if (!this.unreadable) {
        this.setAsideCorruptFile()
      }
    }
  }

  /** Set aside, never overwritten, so it can still be recovered by hand. */
  private setAsideCorruptFile(): void {
    try {
      quarantineCorruptRegistry(this.path)
    } catch (error) {
      // Left in place, it must not be written over: it is read again on the next start.
      this.unreadable = true
      console.error('[runtime] Failed to set aside unreadable share devices:', error)
    }
  }

  // Durable before memory takes it, so a failed write can't revoke or grant only until restart. One
  // write at a time, each from the rows as the last one left them.
  // `update` answers null to leave the file as it is.
  private save(
    update: (devices: readonly BotShareDevice[]) => BotShareDevice[] | null
  ): Promise<void> {
    const write = this.writing.then(async () => {
      if (this.unreadable) {
        throw new Error(`Cannot read ${this.path}; refusing to overwrite it.`)
      }
      const next = update(this.devices)
      if (!next) {
        return
      }
      const devices = [...next, ...this.unparsedRows]
      await writeSecureFileAsync(this.path, JSON.stringify({ v: 1, devices }, null, 2), {
        durable: true
      })
      this.devices = next
    })
    this.writing = write.catch(() => {})
    return write
  }
}
