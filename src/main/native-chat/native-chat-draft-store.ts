// Composer drafts kept by the main process, one sidecar file per chat. A clear deletes the file
// and a write renames a temp file over it, so once either returned it survives the app being
// killed. No fsync: a power loss can still lose the last seconds, as browser storage would.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import {
  removeSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../sidecar-snapshot-file'
import {
  isEmptyNativeChatDraft,
  parseNativeChatDraft,
  type NativeChatDraftStoreResult,
  type PersistedNativeChatDraft,
  type SavedNativeChatDraft
} from '../../shared/native-chat-draft-record'

const FILE_VERSION = 1
// Why a cap at load: drafts die with their chat; this bounds those whose end this client missed.
const MAX_SAVED_DRAFTS = 128

type Saved = { draft: PersistedNativeChatDraft; savedAt: number }
type Intent = { draft: PersistedNativeChatDraft | null; savedAt: number }

type DraftFile =
  | ({ kind: 'draft'; scopeKey: string } & Saved)
  /** Not JSON, JSON with no newer version, or a version-1 file that is not a draft. */
  | { kind: 'garbage' }
  /** A newer build's draft, or a file that could not be read this time: never deleted. */
  | { kind: 'kept'; reason: string }
  | { kind: 'gone' }

export type NativeChatDraftStore = {
  /** Every saved draft, oldest first, once the writes already asked for have landed. */
  load: () => Promise<SavedNativeChatDraft[]>
  /** The same without waiting, for a renderer that needs drafts before an async load returned. */
  loadSync: () => SavedNativeChatDraft[]
  /** Resolves once the file op returned. Writes for one chat apply in the order they arrived. */
  write: (
    scopeKey: string,
    draft: PersistedNativeChatDraft | null
  ) => Promise<NativeChatDraftStoreResult>
  /** Waits for every write asked for so far, then retries each failed one once (at quit). */
  drain: () => Promise<void>
}

function draftFile(root: string, scopeKey: string): string {
  // Why hashed: a pane key holds ':', which Windows refuses in a file name.
  return sidecarSnapshotFile(root, `${createHash('sha256').update(scopeKey).digest('hex')}.json`)
}

function classifyDraftFile(raw: string): DraftFile {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { kind: 'garbage' }
  }
  const v = typeof value === 'object' && value !== null && 'v' in value ? value.v : undefined
  if (typeof v === 'number' && v > FILE_VERSION) {
    return { kind: 'kept', reason: `version ${v}` }
  }
  if (v !== FILE_VERSION) {
    return { kind: 'garbage' }
  }
  const scopeKey =
    typeof value === 'object' && value !== null && 'scopeKey' in value && value.scopeKey
  const savedAt = typeof value === 'object' && value !== null && 'savedAt' in value && value.savedAt
  const draft = parseNativeChatDraft(value)
  return typeof scopeKey === 'string' && draft
    ? { kind: 'draft', scopeKey, draft, savedAt: typeof savedAt === 'number' ? savedAt : 0 }
    : { kind: 'garbage' }
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
}

async function readDraftFile(file: string): Promise<DraftFile> {
  try {
    return classifyDraftFile(await readFile(file, 'utf8'))
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' ? { kind: 'gone' } : { kind: 'kept', reason: code }
  }
}

function oldestFirst(saved: Iterable<[string, Saved]>): SavedNativeChatDraft[] {
  return Array.from(saved)
    .sort((left, right) => left[1].savedAt - right[1].savedAt)
    .map(([scopeKey, { draft }]) => ({ scopeKey, draft }))
}

export function createNativeChatDraftStore(root: string): NativeChatDraftStore {
  // What each chat's draft should be, failed writes included, so a reloaded window never sees
  // text whose clear did not reach the file.
  const saved = new Map<string, Saved>()
  const written = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  // The newest write per chat, so an older failure never outlives a newer write.
  const latest = new Map<string, Intent>()
  // A write whose file op failed: superseded by the chat's next write, else retried once at quit.
  const failed = new Map<string, Intent>()
  let rootReady: Promise<unknown> | null = null
  let loaded = false

  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    )
    return work
  }

  // Load-time deletes go through the chat's queue and recheck, so they never undo a write.
  const removeIfStill = (file: string, stillDoomed: () => Promise<boolean> | boolean) =>
    withSidecarSnapshotQueue(file, async () => {
      if (await stillDoomed()) {
        await removeSidecarSnapshot(file)
      }
    }).catch((error: unknown) => console.warn('[native-chat-drafts] could not delete', file, error))

  const ready = (async () => {
    const found: ({ file: string; scopeKey: string } & Saved)[] = []
    const removals: Promise<void>[] = []
    const names = await readdir(root).catch(() => [])
    // Temp files a killed run left mid-write; this run's own are never swept.
    const interrupted = new Set(
      names.filter((name) => name.endsWith('.tmp')).map((name) => name.split('.json.')[0])
    )
    await Promise.all(
      Array.from(interrupted, (hash) =>
        removeStaleDurableWriteTempFiles(join(root, `${hash}.json`))
      )
    )
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const file = join(root, name)
      const read = await readDraftFile(file)
      switch (read.kind) {
        case 'draft':
          found.push({ ...read, file })
          break
        case 'garbage':
          removals.push(
            removeIfStill(file, async () => (await readDraftFile(file)).kind === 'garbage')
          )
          break
        case 'kept':
          console.warn('[native-chat-drafts] kept a draft file it cannot use:', name, read.reason)
          break
        case 'gone':
          break
      }
    }
    found.sort((left, right) => left.savedAt - right.savedAt)
    for (const [index, entry] of found.entries()) {
      if (written.has(entry.scopeKey)) {
        continue
      }
      if (index < found.length - MAX_SAVED_DRAFTS) {
        removals.push(removeIfStill(entry.file, () => !written.has(entry.scopeKey)))
      } else {
        saved.set(entry.scopeKey, { draft: entry.draft, savedAt: entry.savedAt })
      }
    }
    await Promise.all(removals)
    loaded = true
  })()

  const apply = async (scopeKey: string, { draft, savedAt }: Intent): Promise<void> => {
    const file = draftFile(root, scopeKey)
    if (!draft || isEmptyNativeChatDraft(draft)) {
      await removeSidecarSnapshot(file)
      return
    }
    // Why once: a mkdir per typing pause queues ahead of the clear; any failure makes it again.
    rootReady ??= mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await rootReady
      await writeSidecarSnapshot(
        file,
        { v: FILE_VERSION, scopeKey, savedAt, ...draft },
        { durability: 'process' }
      )
    } catch (error) {
      rootReady = null
      throw error
    }
  }

  const settle = async (): Promise<void> => {
    await Promise.all(pending)
  }

  return {
    load: async () => {
      await ready
      await settle()
      return oldestFirst(saved)
    },
    loadSync: () => {
      if (loaded) {
        return oldestFirst(saved)
      }
      const found: [string, Saved][] = []
      let names: string[] = []
      try {
        names = readdirSync(root).filter((entry) => entry.endsWith('.json'))
      } catch {
        // No drafts folder yet.
      }
      for (const name of names) {
        try {
          const read = classifyDraftFile(readFileSync(join(root, name), 'utf8'))
          if (read.kind === 'draft') {
            found.push([read.scopeKey, read])
          }
        } catch {
          // Unreadable for now: skipped here, judged by the async load.
        }
      }
      return oldestFirst(found).slice(-MAX_SAVED_DRAFTS)
    },
    write: (scopeKey, draft) => {
      written.add(scopeKey)
      failed.delete(scopeKey)
      const intent: Intent = { draft, savedAt: Date.now() }
      latest.set(scopeKey, intent)
      if (draft && !isEmptyNativeChatDraft(draft)) {
        saved.set(scopeKey, { draft, savedAt: intent.savedAt })
      } else {
        saved.delete(scopeKey)
      }
      // Why queued per chat: a typing write still in flight must never land after the clear behind it.
      return track(
        withSidecarSnapshotQueue(draftFile(root, scopeKey), () => apply(scopeKey, intent)).then(
          (): NativeChatDraftStoreResult => {
            if (latest.get(scopeKey) === intent) {
              latest.delete(scopeKey)
            }
            return 'persisted'
          },
          (error: unknown): NativeChatDraftStoreResult => {
            if (latest.get(scopeKey) === intent) {
              failed.set(scopeKey, intent)
            }
            console.warn(
              '[native-chat-drafts] write failed; retrying at its next write or at quit:',
              errorCode(error)
            )
            return 'failed'
          }
        )
      )
    },
    drain: async () => {
      await settle()
      const retries = Array.from(failed)
      failed.clear()
      await Promise.all(
        retries.map(([scopeKey, intent]) =>
          withSidecarSnapshotQueue(draftFile(root, scopeKey), () => apply(scopeKey, intent)).then(
            () => {
              if (latest.get(scopeKey) === intent) {
                latest.delete(scopeKey)
              }
            },
            (error: unknown) =>
              console.warn(
                '[native-chat-drafts] dropped a draft write that failed twice:',
                errorCode(error)
              )
          )
        )
      )
    }
  }
}
