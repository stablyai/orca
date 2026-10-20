import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession,
  type CodexAppServerRpc
} from './codex-app-server-session'
import {
  CODEX_SHARED_STORE_MARKER_FILE,
  linkCodexConversationStore
} from './codex-conversation-store'
import { parseCodexRolloutFileName, compareCodexRolloutRecency } from './codex-rollout-file-name'
import { buildNativeHealInvocation } from './codex-session-index-heal'
import { resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import { readCodexThreadPlacements, type CodexThreadPlacement } from './codex-state-db'

const JOURNAL_FILE = '.orca-shared-store-journal.json'
// A home that cannot finish stays on its own store (today's behaviour) instead of retrying forever.
const MAX_ATTEMPTS = 3
const SESSION_TIMEOUT_MS = 120_000
const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318'

type Journal = { attempts: number; forked: string[] }
type Marker = { version: 1; completed: boolean; reason?: string }

export type CodexSharedStoreMigrationOutcome = 'complete' | 'pending' | 'gave-up'

export type CodexSharedStoreMigrationDeps = {
  run?: typeof runCodexAppServerSession
}

/**
 * Moves one managed account home onto the store home: links its conversation
 * directories, keeps any newer branch only this home's database selected
 * reachable as a fork, carries its pins and sections over, then marks it done.
 * Idempotent; each launch resumes where the last attempt stopped.
 */
export async function migrateCodexHomeToSharedStore(
  managedHome: string,
  storeHome: string,
  deps: CodexSharedStoreMigrationDeps = {}
): Promise<CodexSharedStoreMigrationOutcome> {
  const markerPath = join(managedHome, CODEX_SHARED_STORE_MARKER_FILE)
  const marker = readJson<Marker>(markerPath)
  if (marker) {
    return marker.completed ? 'complete' : 'gave-up'
  }
  const journalPath = join(managedHome, JOURNAL_FILE)
  const journal: Journal = readJson<Journal>(journalPath) ?? { attempts: 0, forked: [] }
  const finish = (completed: boolean, reason?: string): CodexSharedStoreMigrationOutcome => {
    writeFileAtomically(
      markerPath,
      JSON.stringify({ version: 1, completed, ...(reason ? { reason } : {}) })
    )
    rmSync(journalPath, { force: true })
    return completed ? 'complete' : 'gave-up'
  }
  const retryLater = (reason: string): CodexSharedStoreMigrationOutcome => {
    journal.attempts += 1
    if (journal.attempts >= MAX_ATTEMPTS) {
      console.warn('[codex-shared-store] Keeping this account on its own history:', reason)
      return finish(false, reason)
    }
    writeFileAtomically(journalPath, JSON.stringify(journal))
    return 'pending'
  }

  // Read before linking: the home's own DB is the record of what only it selected.
  const own = readCodexThreadPlacements(managedHome)
  const linked = linkCodexConversationStore(managedHome, storeHome)
  if (linked.kind === 'deferred') {
    return 'pending'
  }
  if (linked.kind !== 'linked') {
    return retryLater(
      linked.kind === 'conflict' ? `differing copies of ${linked.paths.join(', ')}` : linked.reason
    )
  }
  if (!own || own.size === 0) {
    return finish(true)
  }
  const shared = readCodexThreadPlacements(resolveEffectiveCodexSqliteHome(storeHome)) ?? new Map()
  const run = deps.run ?? runCodexAppServerSession
  try {
    await preserveNewerBranches(managedHome, storeHome, own, shared, journal, run)
    writeFileAtomically(journalPath, JSON.stringify(journal))
    await indexInSharedStore(
      storeHome,
      [...own.keys()].filter((threadId) => !shared.has(threadId)),
      run
    )
    await carryOverSections(storeHome, own, shared, run)
  } catch (error) {
    return retryLater(error instanceof Error ? error.message : String(error))
  }
  return finish(true)
}

/**
 * A thread this home reverted (its row names a newer segment than the shared
 * row) would resume older history once the home reads the shared DB, and Codex
 * cannot move that row. Forking it under this home's own DB keeps the newer
 * branch as its own conversation, which the shared DB then indexes.
 */
async function preserveNewerBranches(
  managedHome: string,
  storeHome: string,
  own: ReadonlyMap<string, CodexThreadPlacement>,
  shared: ReadonlyMap<string, CodexThreadPlacement>,
  journal: Journal,
  run: typeof runCodexAppServerSession
): Promise<void> {
  const newer = [...own].filter(([threadId, placement]) => {
    const theirs = shared.get(threadId)
    const mine = parseCodexRolloutFileName(placement.fileName)
    const sharedName = theirs ? parseCodexRolloutFileName(theirs.fileName) : null
    return (
      !journal.forked.includes(threadId) &&
      mine !== null &&
      sharedName !== null &&
      compareCodexRolloutRecency(mine, sharedName) > 0
    )
  })
  const forks: string[] = []
  for (const [threadId] of newer) {
    await run(buildNativeHealInvocation(managedHome, SESSION_TIMEOUT_MS), async (rpc) => {
      const forked = await rpc.request('thread/fork', { threadId })
      const forkId = readThreadId(forked)
      if (forkId) {
        forks.push(forkId)
      }
    })
    journal.forked.push(threadId)
  }
  if (forks.length > 0) {
    // Seed the forks into the shared DB so every account lists them.
    await run(buildNativeHealInvocation(storeHome, SESSION_TIMEOUT_MS), async (rpc) => {
      for (const forkId of forks) {
        await rpc.request('thread/read', { threadId: forkId })
      }
    })
  }
}

const INDEX_BATCH_SIZE = 50

/** Codex's resume picker lists only indexed threads; seed the ones only this home's DB knew. */
async function indexInSharedStore(
  storeHome: string,
  threadIds: readonly string[],
  run: typeof runCodexAppServerSession
): Promise<void> {
  for (let start = 0; start < threadIds.length; start += INDEX_BATCH_SIZE) {
    const batch = threadIds.slice(start, start + INDEX_BATCH_SIZE)
    await run(buildNativeHealInvocation(storeHome, SESSION_TIMEOUT_MS), async (rpc) => {
      for (const threadId of batch) {
        try {
          await rpc.request('thread/read', { threadId })
        } catch (error) {
          // A thread whose files are gone has nothing to list.
          if (!/no rollout found/i.test(error instanceof Error ? error.message : '')) {
            throw error
          }
        }
      }
    })
  }
}

/** Replays this home's pins and sections into the shared store; the later placement wins. */
async function carryOverSections(
  storeHome: string,
  own: ReadonlyMap<string, CodexThreadPlacement>,
  shared: ReadonlyMap<string, CodexThreadPlacement>,
  run: typeof runCodexAppServerSession
): Promise<void> {
  const moves = [...own]
    .filter(([threadId, placement]) => {
      const theirs = shared.get(threadId)
      return (
        placement.sectionId !== null &&
        (placement.enteredAtMs ?? 0) > (theirs?.enteredAtMs ?? -1) &&
        theirs?.sectionId !== placement.sectionId
      )
    })
    .sort(([, left], [, right]) => (left.position ?? 0) - (right.position ?? 0))
  if (moves.length === 0) {
    return
  }
  try {
    await run(buildNativeHealInvocation(storeHome, SESSION_TIMEOUT_MS), async (rpc) => {
      const sectionIdsByName = await listSectionIdsByName(rpc)
      for (const [threadId, placement] of moves) {
        const sectionId = await sharedSectionId(rpc, placement, sectionIdsByName)
        if (!shared.has(threadId)) {
          // A thread the shared DB has not indexed yet must exist before it can move.
          await rpc.request('thread/read', { threadId })
        }
        await rpc.request('thread/section/move', { threadId, sectionId })
      }
    })
  } catch (error) {
    // A Codex too old for sections has none to carry over.
    if (!isCodexAppServerUnsupportedError(error)) {
      throw error
    }
  }
}

async function listSectionIdsByName(rpc: CodexAppServerRpc): Promise<Map<string, string>> {
  const listed = await rpc.request('threadSection/list', {})
  const byName = new Map<string, string>()
  const data = field(listed, 'data')
  for (const section of Array.isArray(data) ? data : []) {
    const id = field(section, 'id')
    const name = field(section, 'name')
    if (typeof id === 'string' && typeof name === 'string') {
      byName.set(name, id)
    }
  }
  return byName
}

async function sharedSectionId(
  rpc: CodexAppServerRpc,
  placement: CodexThreadPlacement,
  sectionIdsByName: Map<string, string>
): Promise<string> {
  if (placement.sectionId === PINNED_SECTION_ID || !placement.sectionName) {
    return PINNED_SECTION_ID
  }
  const existing = sectionIdsByName.get(placement.sectionName)
  if (existing) {
    return existing
  }
  const created = await rpc.request('threadSection/create', { name: placement.sectionName })
  const id = field(field(created, 'section'), 'id')
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Codex did not name the section it created for "${placement.sectionName}"`)
  }
  sectionIdsByName.set(placement.sectionName, id)
  return id
}

function readThreadId(response: unknown): string | null {
  const id = field(field(response, 'thread'), 'id')
  return typeof id === 'string' && id.length > 0 ? id : null
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? new Map(Object.entries(value)).get(key) : undefined
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Orca alone writes these two files, with exactly these shapes.
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

const inFlightByHome = new Map<string, Promise<CodexSharedStoreMigrationOutcome>>()

/** Starts one home's move onto the shared store, unless one is already running. */
export function startCodexSharedStoreMigrationInBackground(args: {
  managedHome: string
  storeHome: string
}): void {
  if (!inFlightByHome.has(args.managedHome)) {
    const task = migrateCodexHomeToSharedStore(args.managedHome, args.storeHome)
      .catch((error: unknown) => {
        console.warn('[codex-shared-store] Migration attempt failed:', error)
        return 'pending' as const
      })
      .finally(() => inFlightByHome.delete(args.managedHome))
    inFlightByHome.set(args.managedHome, task)
  }
}

export function settleCodexSharedStoreMigrationsForTests(): Promise<unknown> {
  return Promise.all(inFlightByHome.values())
}
