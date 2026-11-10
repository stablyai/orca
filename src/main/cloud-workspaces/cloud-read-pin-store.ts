// What this device remembers about each sleeping workspace's read snapshots: the VM signer it
// trusts and the newest copy it has shown (read-snapshot-signature.ts). One small JSON file per Orca
// profile, keyed by account and workspace. Nothing in it is secret; it is integrity state, so it
// survives restarts (a rollback after a restart is still refused) and is dropped on sign-out.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ReadSnapshotPin } from '../../shared/cloud-workspaces/read-snapshot-signature'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'

export const READ_PIN_FILE_NAME = 'cloud-read-pins.json'
/** Bounded: oldest-touched pins go first (a dropped pin falls back to trust on first use). */
const MAX_PINS = 500

type PinFile = { version: 1; pins: Record<string, ReadSnapshotPin & { touchedAt: number }> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePins(text: string): PinFile['pins'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.pins)) {
    return {}
  }
  const out: PinFile['pins'] = {}
  for (const [key, value] of Object.entries(parsed.pins)) {
    if (
      isRecord(value) &&
      (value.signerPublicKeyB64 === null || typeof value.signerPublicKeyB64 === 'string') &&
      typeof value.newestCapturedAt === 'number' &&
      Number.isFinite(value.newestCapturedAt)
    ) {
      out[key] = {
        signerPublicKeyB64: value.signerPublicKeyB64,
        newestCapturedAt: value.newestCapturedAt,
        touchedAt: typeof value.touchedAt === 'number' ? value.touchedAt : 0
      }
    }
  }
  return out
}

export function getCloudReadPinPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), READ_PIN_FILE_NAME)
}

export function createReadPinStore(deps: {
  pathFor: (profileId: string) => string
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const files = new Map<string, Promise<PinFile['pins']>>()
  // Writes per file run one at a time, each from the latest in-memory state.
  const writes = new Map<string, Promise<void>>()

  function pinsOf(path: string): Promise<PinFile['pins']> {
    let loaded = files.get(path)
    if (!loaded) {
      loaded = readFile(path, 'utf8').then(parsePins, () => ({}))
      files.set(path, loaded)
    }
    return loaded
  }

  function persist(path: string, pins: PinFile['pins']): Promise<void> {
    const previous = writes.get(path) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const body: PinFile = { version: 1, pins }
        const temp = `${path}.${process.pid}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temp, JSON.stringify(body), { mode: 0o600 })
        await rename(temp, path)
      })
    writes.set(path, next)
    return next
  }

  return {
    async get(profileId: string, key: string): Promise<ReadSnapshotPin | null> {
      const pin = (await pinsOf(deps.pathFor(profileId)))[key]
      return pin
        ? { signerPublicKeyB64: pin.signerPublicKeyB64, newestCapturedAt: pin.newestCapturedAt }
        : null
    },
    async set(profileId: string, key: string, pin: ReadSnapshotPin): Promise<void> {
      const path = deps.pathFor(profileId)
      const pins = await pinsOf(path)
      pins[key] = { ...pin, touchedAt: now() }
      const keys = Object.keys(pins)
      if (keys.length > MAX_PINS) {
        keys
          .sort((a, b) => pins[a]!.touchedAt - pins[b]!.touchedAt)
          .slice(0, keys.length - MAX_PINS)
          .forEach((old) => delete pins[old])
      }
      await persist(path, pins)
    },
    /** Sign-out: the next account on this profile starts with no pins. */
    async clear(profileId: string): Promise<void> {
      const path = deps.pathFor(profileId)
      await writes.get(path)?.catch(() => undefined)
      files.set(path, Promise.resolve({}))
      await rm(path, { force: true })
    }
  }
}

export type ReadPinStore = ReturnType<typeof createReadPinStore>

let defaultStore: { userDataPath: string; store: ReadPinStore } | null = null

export function getCloudReadPinStore(userDataPath: string): ReadPinStore {
  if (defaultStore?.userDataPath !== userDataPath) {
    defaultStore = {
      userDataPath,
      store: createReadPinStore({
        pathFor: (profileId) => getCloudReadPinPath(profileId, userDataPath)
      })
    }
  }
  return defaultStore.store
}

/** Sign-out hook (beside the reader key). Never throws. */
export async function clearCloudReadPins(profileId: string, userDataPath: string): Promise<void> {
  try {
    await getCloudReadPinStore(userDataPath).clear(profileId)
  } catch (error) {
    console.error(`[orca-cloud] clearing read snapshot pins failed: ${String(error)}`)
  }
}
