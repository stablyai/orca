import {
  readPageDeviceStore,
  type PageDeviceStore
} from '../mobile-web-shell/bridge/page-device-store'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'

// Typed text outlives the page: each owner keeps one row, saved after typing settles and at once when emptied.
const SAVE_DEBOUNCE_MS = 250

/** Where a row lives. A failed read leaves the row unloaded; a write answers whether it stuck. */
export type DurableDraftRowBackend = {
  read: () => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }>
  write: (value: unknown) => Promise<boolean>
}

export type DurableDraftRowOwner = {
  // Picked at the first load: the device store when the shell grants it, else the owner's fallback.
  backend: () => DurableDraftRowBackend
  // What the row should hold now; null removes it.
  snapshot: () => unknown
  // Hands back what the row held; the owner puts it back only where the input is still untouched.
  restore: (saved: unknown) => void
}

export type DurableDraftRow = {
  readonly key: string
  readonly state: () => 'pending' | 'loaded'
  /** Reads the row once per page; later calls wait for every earlier read and write. */
  load: () => Promise<void>
  save: (timing: 'immediate' | 'deferred') => void
}

type Row = {
  owner: DurableDraftRowOwner
  backend: DurableDraftRowBackend | null
  // Every read and write of the row runs in order, the load first.
  chain: Promise<void>
  state: 'pending' | 'loaded'
  // What the backend holds; undefined after a failed write, so the next save cannot match it.
  written: string | undefined
  timer: ReturnType<typeof setTimeout> | null
  handle: DurableDraftRow
}

const rows = new Map<string, Row>()

// The store refuses keys past 512 characters; a long worktree path or id is hashed instead.
const MAX_KEY_LENGTH = 512

function fnv1a(text: string, seed: number): string {
  let hash = seed
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `draft:<namespace>:<worktree or ''>:<id>`; the shell binds the host. */
export function durableDraftRowKey(namespace: string, worktreeId: string, id: string): string {
  const key = `draft:${namespace}:${worktreeId}:${id}`
  if (key.length <= MAX_KEY_LENGTH) {
    return key
  }
  const rest = `${worktreeId}:${id}`
  return `draft:${namespace}:#${fnv1a(rest, 0x811c9dc5)}${fnv1a(rest, 0x01000193)}`
}

export function deviceStoreDraftBackend(
  store: PageDeviceStore,
  key: string
): DurableDraftRowBackend {
  return {
    read: async () => {
      const read = await store.read('draft', [key])
      if (read.status !== 'ok') {
        return { ok: false }
      }
      const raw = read.values[0] ?? null
      const value = raw === null ? null : decodeDeviceStoreValue(raw)
      if (value === undefined) {
        // A value that fails to decode is removed, never shown.
        await store.write('draft', [{ key, value: null }])
        return { ok: true, value: null }
      }
      return { ok: true, value }
    },
    write: async (value) =>
      (
        await store.write('draft', [
          { key, value: value === null ? null : encodeDeviceStoreValue(value) }
        ])
      ).written
  }
}

// An older shell grants no store; there the row lives only as long as the page.
const MEMORY_BACKEND: DurableDraftRowBackend = {
  read: async () => ({ ok: true, value: null }),
  write: async () => true
}

/** The device store when the shell grants it, else memory only, as before the store existed. */
export function pageDraftRowBackend(key: string): DurableDraftRowBackend {
  const store = readPageDeviceStore()
  return store?.available() ? deviceStoreDraftBackend(store, key) : MEMORY_BACKEND
}

function enqueue(row: Row, step: () => Promise<void>): Promise<void> {
  row.chain = row.chain.then(step).catch((error: unknown) => {
    console.warn('[draft-rows] a draft could not be saved; it is kept in memory', error)
  })
  return row.chain
}

async function load(row: Row): Promise<void> {
  if (row.state !== 'pending') {
    return
  }
  row.backend ??= row.owner.backend()
  const read = await row.backend.read()
  if (!read.ok) {
    // A dropped or refused read is retried, backend re-picked, at the next save; until then the text stays in memory.
    row.backend = null
    return
  }
  row.state = 'loaded'
  row.written = JSON.stringify(read.value ?? null)
  if (read.value !== null && read.value !== undefined) {
    row.owner.restore(read.value)
  }
}

async function write(row: Row): Promise<void> {
  await load(row)
  if (row.state !== 'loaded' || !row.backend) {
    return
  }
  const value = row.owner.snapshot() ?? null
  const serialized = JSON.stringify(value)
  if (serialized === row.written) {
    return
  }
  row.written = undefined
  if (await row.backend.write(value)) {
    row.written = serialized
  }
}

function flush(row: Row): void {
  if (row.timer !== null) {
    clearTimeout(row.timer)
    row.timer = null
  }
  void enqueue(row, () => write(row))
}

// The app going to the background may be the last chance before it is killed, so pending typing saves then.
function flushPendingOnHide(): void {
  if (document.visibilityState !== 'hidden') {
    return
  }
  for (const row of rows.values()) {
    if (row.timer !== null) {
      flush(row)
    }
  }
}

let flushOnHideInstalled = false

/** One row per key for the page's life; the first owner to open a key keeps it. */
export function durableDraftRow(key: string, owner: DurableDraftRowOwner): DurableDraftRow {
  const existing = rows.get(key)
  if (existing) {
    return existing.handle
  }
  if (!flushOnHideInstalled && typeof document !== 'undefined') {
    flushOnHideInstalled = true
    document.addEventListener('visibilitychange', flushPendingOnHide)
  }
  const row: Row = {
    owner,
    backend: null,
    chain: Promise.resolve(),
    state: 'pending',
    written: undefined,
    timer: null,
    handle: {
      key,
      state: () => row.state,
      load: () => enqueue(row, () => load(row)),
      save: (timing) => {
        if (timing === 'immediate') {
          flush(row)
          return
        }
        row.timer ??= setTimeout(() => flush(row), SAVE_DEBOUNCE_MS)
      }
    }
  }
  rows.set(key, row)
  return row.handle
}

export function resetDurableDraftRowsForTests(): void {
  for (const row of rows.values()) {
    if (row.timer !== null) {
      clearTimeout(row.timer)
    }
  }
  rows.clear()
}
