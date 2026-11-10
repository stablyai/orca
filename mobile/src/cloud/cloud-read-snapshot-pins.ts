import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import {
  pinFromGrant,
  type ReadSnapshotPin
} from '../../../src/shared/cloud-workspaces/read-snapshot-signature'

// Per (device session, workspace): the VM signer this phone pinned and the newest capture it showed
// (read-snapshot-signature.ts). Nothing secret, so AsyncStorage; persisted so a relaunch cannot be
// used to slip in an older or foreign copy. One small map per device session, dropped with it.
const PREFIX = 'orca.cloud-read-pins.v1:'
/** Bounds the map; the least recently shown workspaces are forgotten first. */
const MAX_PINS = 300

const PinSchema = z.object({
  signerPublicKeyB64: z.string().max(64).nullable(),
  newestCapturedAt: z.number()
})
const PinMapSchema = z.record(z.string(), PinSchema)

type PinMap = Record<string, ReadSnapshotPin>

// Read-modify-write in order, so two reads finishing together never lose a pin.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function readMap(deviceSessionId: string): Promise<PinMap> {
  const raw = await AsyncStorage.getItem(PREFIX + deviceSessionId)
  if (!raw) {
    return {}
  }
  try {
    const parsed = PinMapSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

async function writeMap(deviceSessionId: string, map: PinMap): Promise<void> {
  const entries = Object.entries(map)
  const kept =
    entries.length > MAX_PINS
      ? entries.sort((a, b) => b[1].newestCapturedAt - a[1].newestCapturedAt).slice(0, MAX_PINS)
      : entries
  await AsyncStorage.setItem(PREFIX + deviceSessionId, JSON.stringify(Object.fromEntries(kept)))
}

export function loadCloudReadSnapshotPin(
  deviceSessionId: string,
  sandboxId: string
): Promise<ReadSnapshotPin | null> {
  return serial(async () => (await readMap(deviceSessionId))[sandboxId] ?? null)
}

export function saveCloudReadSnapshotPin(
  deviceSessionId: string,
  sandboxId: string,
  pin: ReadSnapshotPin
): Promise<void> {
  return serial(async () => {
    const map = await readMap(deviceSessionId)
    const current = map[sandboxId]
    // Never move the capture pin backwards, whichever write lands last.
    map[sandboxId] = {
      signerPublicKeyB64: pin.signerPublicKeyB64,
      newestCapturedAt: Math.max(pin.newestCapturedAt, current?.newestCapturedAt ?? 0)
    }
    await writeMap(deviceSessionId, map)
  })
}

/** The sealed grant this phone paired with names the workspace's signer: pin (or re-pin) it. */
export function recordCloudReadSignerFromGrant(
  deviceSessionId: string,
  sandboxId: string,
  signerPublicKeyB64: string
): Promise<void> {
  return serial(async () => {
    const map = await readMap(deviceSessionId)
    map[sandboxId] = pinFromGrant(map[sandboxId] ?? null, signerPublicKeyB64)
    await writeMap(deviceSessionId, map)
  })
}

/** Drops every session's pins, with the enrollment they belonged to. */
export function clearCloudReadSnapshotPins(): Promise<void> {
  return serial(async () => {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX))
    if (keys.length > 0) {
      await AsyncStorage.multiRemove(keys)
    }
  })
}
