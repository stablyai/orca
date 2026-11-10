import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import {
  mergeReadSnapshotPin,
  pinFromGrant,
  repinAfterPairing,
  type ReadSnapshotPin
} from '../../../src/shared/cloud-workspaces/read-snapshot-signature'

// Per (device session, workspace): the VM signer this phone pinned and the newest capture it showed
// (read-snapshot-signature.ts). Nothing secret, so AsyncStorage; persisted so a relaunch cannot be
// used to slip in an older or foreign copy. One small map per device session, dropped with it.
// Every write is a read-modify-write inside one queue, applying the shared policy to what is
// stored *now*: a stale read never moves the floor back or undoes a grant pin or a re-pin.
const PREFIX = 'orca.cloud-read-pins.v1:'
/** Bounds the map; the least recently used workspaces are forgotten first. */
const MAX_PINS = 300

const EntrySchema = z.object({
  signerPublicKeyB64: z.string().max(64).nullable(),
  newestCapturedAt: z.number(),
  lastUsedAt: z.number().optional()
})
const EntryMapSchema = z.record(z.string(), EntrySchema)

type Entry = z.infer<typeof EntrySchema>
type EntryMap = Record<string, Entry>

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

async function readMap(deviceSessionId: string): Promise<EntryMap> {
  const raw = await AsyncStorage.getItem(PREFIX + deviceSessionId)
  if (!raw) {
    return {}
  }
  try {
    const parsed = EntryMapSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function pinOf(entry: Entry | undefined): ReadSnapshotPin | null {
  return entry
    ? { signerPublicKeyB64: entry.signerPublicKeyB64, newestCapturedAt: entry.newestCapturedAt }
    : null
}

/** Applies `update` to one workspace's stored pin, atomically; null removes nothing and writes nothing. */
function update(
  deviceSessionId: string,
  sandboxId: string,
  apply: (stored: ReadSnapshotPin | null) => ReadSnapshotPin | null,
  now: number
): Promise<void> {
  return serial(async () => {
    const map = await readMap(deviceSessionId)
    const next = apply(pinOf(map[sandboxId]))
    if (!next) {
      return
    }
    map[sandboxId] = { ...next, lastUsedAt: now }
    const entries = Object.entries(map)
    const kept =
      entries.length > MAX_PINS
        ? entries.sort((a, b) => (b[1].lastUsedAt ?? 0) - (a[1].lastUsedAt ?? 0)).slice(0, MAX_PINS)
        : entries
    await AsyncStorage.setItem(PREFIX + deviceSessionId, JSON.stringify(Object.fromEntries(kept)))
  })
}

export function loadCloudReadSnapshotPin(
  deviceSessionId: string,
  sandboxId: string
): Promise<ReadSnapshotPin | null> {
  return serial(async () => pinOf((await readMap(deviceSessionId))[sandboxId]))
}

/**
 * Records a shown snapshot: `next` is the verdict's pin, `checkedAgainst` the pin the verdict was
 * decided on. mergeReadSnapshotPin keeps the floor moving forward only, and keeps any signer change
 * (grant pin, forget) that landed after the read.
 */
export function commitCloudReadSnapshotPin(
  deviceSessionId: string,
  sandboxId: string,
  checkedAgainst: ReadSnapshotPin | null,
  next: ReadSnapshotPin,
  now: number = Date.now()
): Promise<void> {
  return update(
    deviceSessionId,
    sandboxId,
    (stored) => mergeReadSnapshotPin(stored, checkedAgainst, next),
    now
  )
}

/** A sealed grant names the workspace's signer: it fills an empty pin only, never replaces one. */
export function recordCloudReadSignerFromGrant(
  deviceSessionId: string,
  sandboxId: string,
  signerPublicKeyB64: string,
  now: number = Date.now()
): Promise<void> {
  return update(
    deviceSessionId,
    sandboxId,
    (stored) => pinFromGrant(stored, signerPublicKeyB64),
    now
  )
}

/**
 * This phone completed the end-to-end encrypted pairing with the workspace's orcad using the grant
 * that named this signer: only then may it replace a pinned signer (a rebuilt sandbox). The floor stays.
 */
export function repinCloudReadSignerAfterPairing(
  deviceSessionId: string,
  sandboxId: string,
  signerPublicKeyB64: string,
  now: number = Date.now()
): Promise<void> {
  return update(
    deviceSessionId,
    sandboxId,
    (stored) => repinAfterPairing(stored, signerPublicKeyB64),
    now
  )
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
