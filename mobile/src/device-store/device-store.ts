import type {
  DeviceStore,
  DeviceStoreOptions,
  DeviceStoreWriteResult
} from './device-store-contract'
import type { AESEncryptionKey } from 'expo-crypto'
import { Directory, Paths } from 'expo-file-system'
import { AppState } from 'react-native'
import { createExpoGenerationFileSystem } from '../mobile-web-shell/generation-store-file-system'
import { loadStoredHostProfiles } from '../transport/hosts/host-metadata-store'
import {
  readPairingKeychainItem,
  writePairingKeychainItem
} from '../transport/hosts/pairing-keychain'
import {
  createRootIndex,
  DEVICE_STORE_CAPS,
  evictLeastRecentlyUsed,
  forgetIndexedDirectory,
  forgetIndexedFile,
  keepOnlyIndexedFiles,
  recordIndexedFile,
  resetRootIndex,
  seedRootIndex,
  wouldExceedCap,
  type RootIndex
} from './device-store-eviction'
import {
  DEVICE_STORE_TABLES,
  deviceStoreRows,
  hostDirectoryUri,
  readDeviceStoreRow,
  writeDeviceStoreRow
} from './device-store-files'
import { DEVICE_STORE_KEY_ITEM, loadDeviceStoreKey } from './device-store-key'
import { sealDeviceStoreValue, type DeviceStoreTable } from './device-store-seal'
import { DEVICE_STORE_MAX_VALUE_LENGTH } from './device-store-value-codec'

const UNAVAILABLE: DeviceStoreWriteResult = { written: false, refusal: 'unavailable' }

export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
  const fs = options.fileSystem
  const { roots } = options
  const indexes: Record<DeviceStoreTable, RootIndex> = {
    cache: createRootIndex(),
    draft: createRootIndex()
  }
  // Draft writes and the tmp-wins read are several file steps; one queue keeps them from interleaving.
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }

  let key: AESEncryptionKey | null = null
  let opening: Promise<'ready' | 'unavailable'> | null = null

  const hasStoredValues = async (): Promise<boolean> => {
    for (const table of DEVICE_STORE_TABLES) {
      if ((await fs.list(roots[table])).length > 0) {
        return true
      }
    }
    return false
  }
  const wipeAllValues = async (): Promise<void> => {
    for (const table of DEVICE_STORE_TABLES) {
      await fs.delete(roots[table])
      resetRootIndex(indexes[table])
    }
  }

  const open = (): Promise<'ready' | 'unavailable'> => {
    if (key) {
      return Promise.resolve('ready')
    }
    opening ??= enqueue(async () => {
      key = await loadDeviceStoreKey({ keychain: options.keychain, hasStoredValues, wipeAllValues })
      return key ? 'ready' : 'unavailable'
    }).finally(() => {
      opening = null
    })
    return opening
  }

  const seedRoot = (table: DeviceStoreTable, exact: boolean): Promise<void> =>
    seedRootIndex({
      fs,
      table,
      exact,
      rootUri: roots[table],
      index: indexes[table],
      now: Date.now(),
      loadPairedHostIds: options.loadPairedHostIds,
      runSlice: (slice) =>
        enqueue(slice).then(
          () => true,
          () => false
        )
    })

  // LRU order needs every file, so the first time the cache's estimate crosses its cap, one exact pass lists
  // it (in idle slices, while other writes go on) and eviction runs on the exact total. The cache write that
  // crossed the cap waits for it; that happens once a session, again only to retry a pass that missed files.
  let exactCachePass: Promise<void> | null = null
  const runExactCachePass = (): Promise<void> => {
    exactCachePass ??= enqueue(async () => keepOnlyIndexedFiles(indexes.cache))
      .then(() => seedRoot('cache', true))
      .finally(() => {
        exactCachePass = null
      })
    return exactCachePass
  }
  const enforceCacheCap = async (): Promise<void> => {
    const index = indexes.cache
    if (!index.seeded || index.total <= DEVICE_STORE_CAPS.cache) {
      return
    }
    if (!index.exact) {
      await runExactCachePass()
    }
    // A failed eviction retries on the next write.
    await enqueue(() => evictLeastRecentlyUsed(fs, index, DEVICE_STORE_CAPS.cache)).catch(
      () => undefined
    )
  }

  let maintenance: Promise<void> | null = null
  const fencedCacheHosts = new Set<string>()

  // The first key load heads the queue, so every call runs behind it in call order. An unavailable store
  // stays unavailable until open() runs again (the next foreground), not per call.
  void open()

  return {
    open,
    read(hostId, table, keys) {
      return enqueue(async () => {
        const cryptoKey = key
        if (!cryptoKey) {
          return { status: 'unavailable' } as const
        }
        const index = indexes[table]
        // Distinct keys touch distinct files, so their native reads and decrypts can overlap.
        const rows = deviceStoreRows(roots, hostId, table, Array.from(new Set(keys)))
        // Settle every row before releasing the queue, so no draft recovery outlives this task.
        const settled = await Promise.allSettled(
          rows.map((row) => readDeviceStoreRow(fs, cryptoKey, row))
        )
        const reads: Awaited<ReturnType<typeof readDeviceStoreRow>>[] = []
        for (const outcome of settled) {
          if (outcome.status === 'rejected') {
            // Unreadable is not absent: report unavailable and delete nothing.
            return { status: 'unavailable' } as const
          }
          reads.push(outcome.value)
        }
        const byKey = new Map<string, string | null>()
        rows.forEach((row, at) => {
          const read = reads[at]
          if (read) {
            recordIndexedFile(index, row.uri, read.bytes, Date.now())
          } else {
            forgetIndexedFile(index, row.uri)
          }
          byKey.set(row.key, read?.value ?? null)
        })
        return {
          status: 'ok',
          values: keys.map((valueKey) => byKey.get(valueKey) ?? null)
        } as const
      })
    },
    async write(hostId, table, ops) {
      if (ops.some((op) => op.value !== null && op.value.length > DEVICE_STORE_MAX_VALUE_LENGTH)) {
        return { written: false, refusal: 'too-large' }
      }
      const result = await enqueue(async (): Promise<DeviceStoreWriteResult> => {
        const cryptoKey = key
        // Checked in turn, so a write queued before a revocation's wipe lands before it and is wiped.
        if (!cryptoKey || (table === 'cache' && fencedCacheHosts.has(hostId))) {
          return UNAVAILABLE
        }
        const index = indexes[table]
        const rows = deviceStoreRows(
          roots,
          hostId,
          table,
          ops.map((op) => op.key)
        )
        try {
          const sealed = await Promise.all(
            ops.map(async (op, at) => {
              const row = rows[at]!
              const bytes =
                op.value === null ? null : await sealDeviceStoreValue(cryptoKey, row, op.value)
              return { row, bytes }
            })
          )
          const changes = sealed.map(({ row, bytes }) => ({
            uri: row.uri,
            size: bytes?.byteLength ?? null
          }))
          if (table === 'draft' && wouldExceedCap(index, DEVICE_STORE_CAPS.draft, changes)) {
            return { written: false, refusal: 'over-cap' } as const
          }
          for (const { row, bytes } of sealed) {
            await writeDeviceStoreRow(fs, row, bytes)
            if (bytes) {
              recordIndexedFile(index, row.uri, bytes.byteLength, Date.now())
            } else {
              forgetIndexedFile(index, row.uri)
            }
          }
        } catch {
          return UNAVAILABLE
        }
        return { written: true } as const
      })
      if (result.written && table === 'cache') {
        await enforceCacheCap()
      }
      return result
    },
    fenceHostCache(hostId, fenced) {
      void (fenced ? fencedCacheHosts.add(hostId) : fencedCacheHosts.delete(hostId))
    },
    wipeHost(hostId, tables = DEVICE_STORE_TABLES) {
      return enqueue(async () => {
        for (const table of tables) {
          const hostUri = hostDirectoryUri(roots, table, hostId)
          await fs.delete(hostUri)
          forgetIndexedDirectory(indexes[table], hostUri)
        }
      })
    },
    runLaunchMaintenance() {
      maintenance ??= (async () => {
        const { cache, draft } = indexes
        if (!draft.seeded || !draft.complete) {
          await seedRoot('draft', true)
        }
        // An incomplete estimate can't be topped up without counting buckets twice, so a retry lists every file.
        if (!cache.seeded) {
          await seedRoot('cache', false)
        } else if (!cache.complete) {
          await runExactCachePass()
        }
        await enforceCacheCap()
      })().finally(() => {
        maintenance = null
      })
      return maintenance
    }
  }
}

let processStore: DeviceStore | null = null
let started = false

export function processDeviceStore(): DeviceStore {
  processStore ??= createDeviceStore({
    fileSystem: createExpoGenerationFileSystem(),
    roots: {
      cache: new Directory(Paths.cache, 'orca-store', 'v1').uri,
      draft: new Directory(Paths.document, 'orca-drafts', 'v1').uri
    },
    keychain: {
      read: () => readPairingKeychainItem(DEVICE_STORE_KEY_ITEM),
      write: (hexKey) => writePairingKeychainItem(DEVICE_STORE_KEY_ITEM, hexKey)
    },
    loadPairedHostIds: async () => (await loadStoredHostProfiles())?.map((host) => host.id) ?? null
  })
  return processStore
}

// Once per process, after the splash: the sweeps' AsyncStorage and file reads would otherwise compete with
// the launch work that holds the splash. Native Home's first read may have loaded the key already. Runs the launch sweeps
// and index seed in idle slices, and on each return to the foreground retries an unavailable store and a
// pass that missed files.
export function startDeviceStore(): void {
  if (started) {
    return
  }
  started = true
  const store = processDeviceStore()
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void store.open()
      void store.runLaunchMaintenance().catch(() => undefined)
    }
  })
  void store.runLaunchMaintenance().catch(() => undefined)
}

// Removal doesn't wait on this; the launch orphan sweep catches a crash in between.
export function wipeHostStore(hostId: string): Promise<void> {
  return processDeviceStore().wipeHost(hostId)
}
