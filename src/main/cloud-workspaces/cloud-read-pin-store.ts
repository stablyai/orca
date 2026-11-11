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
  // Every update of a file is one read-modify-write in this queue: the change is decided against
  // the pin stored at that moment (never one read earlier), then written before the next runs.
  const queues = new Map<string, Promise<unknown>>()

  function pinsOf(path: string): Promise<PinFile['pins']> {
    let loaded = files.get(path)
    if (!loaded) {
      loaded = readFile(path, 'utf8').then(parsePins, () => ({}))
      files.set(path, loaded)
    }
    return loaded
  }

  function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(run)
    queues.set(path, result)
    return result
  }

  async function write(path: string, pins: PinFile['pins']): Promise<void> {
    const body: PinFile = { version: 1, pins }
    const temp = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, JSON.stringify(body), { mode: 0o600 })
    await rename(temp, path)
  }

  const plain = (pin: PinFile['pins'][string] | undefined): ReadSnapshotPin | null =>
    pin
      ? { signerPublicKeyB64: pin.signerPublicKeyB64, newestCapturedAt: pin.newestCapturedAt }
      : null

  return {
    async get(profileId: string, key: string): Promise<ReadSnapshotPin | null> {
      return plain((await pinsOf(deps.pathFor(profileId)))[key])
    },
    /**
     * Atomic read-modify-write of one pin: `change` sees the pin stored now and returns the one to
     * keep (null removes it). Resolves with what was stored.
     */
    update(
      profileId: string,
      key: string,
      change: (stored: ReadSnapshotPin | null) => ReadSnapshotPin | null
    ): Promise<ReadSnapshotPin | null> {
      const path = deps.pathFor(profileId)
      return serialized(path, async () => {
        const pins = await pinsOf(path)
        const next = change(plain(pins[key]))
        if (next) {
          pins[key] = { ...next, touchedAt: now() }
        } else {
          delete pins[key]
        }
        // Least recently used go first; a dropped pin falls back to trust on first use.
        const keys = Object.keys(pins)
        if (keys.length > MAX_PINS) {
          keys
            .sort((a, b) => pins[a]!.touchedAt - pins[b]!.touchedAt)
            .slice(0, keys.length - MAX_PINS)
            .forEach((old) => delete pins[old])
        }
        await write(path, pins)
        return next
      })
    },
    /** Sign-out: the next account on this profile starts with no pins. */
    clear(profileId: string): Promise<void> {
      const path = deps.pathFor(profileId)
      return serialized(path, async () => {
        files.set(path, Promise.resolve({}))
        await rm(path, { force: true })
      })
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
