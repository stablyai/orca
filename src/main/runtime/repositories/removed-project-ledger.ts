import { mkdirSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RemovedProjectTombstone } from '../../../shared/repository/orphaned-chat-rekey'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'

type Entry = { tombstone: Promise<RemovedProjectTombstone>; settled: Promise<void> }
type StoredTombstone = RemovedProjectTombstone & { removedAt: number }

/** How long a removed project stays claimable by a re-add (default, not measured). */
export const REMOVED_PROJECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LEDGER_FILE_NAME = 'removed-projects.json'

/** Projects removed in this app session (their teardown may still be running). */
const removed = new Map<string, Entry>()
/** Same projects on disk in this instance's own data folder, so a re-add after an app restart still
 *  finds them. Loaded once per process; consumed once (a claim deletes the row). */
let stored: Map<string, StoredTombstone> | null = null
let ledgerFile: string | null | undefined

function ledgerPath(): string | null {
  if (ledgerFile !== undefined) {
    return ledgerFile
  }
  try {
    return join(getAppEnvironment().getPath('userData'), LEDGER_FILE_NAME)
  } catch {
    return null
  }
}

function loadStored(): Map<string, StoredTombstone> {
  if (stored) {
    return stored
  }
  stored = new Map()
  const path = ledgerPath()
  if (!path) {
    return stored
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const rows = Array.isArray((parsed as { removed?: unknown })?.removed)
      ? ((parsed as { removed: unknown[] }).removed as Partial<StoredTombstone>[])
      : []
    const oldest = Date.now() - REMOVED_PROJECT_RETENTION_MS
    for (const row of rows) {
      if (
        typeof row?.repoId === 'string' &&
        typeof row.path === 'string' &&
        (row.kind === 'git' || row.kind === 'folder') &&
        typeof row.executionHostId === 'string' &&
        (typeof row.identity === 'string' || row.identity === null) &&
        typeof row.removedAt === 'number' &&
        row.removedAt >= oldest
      ) {
        stored.set(row.repoId, {
          repoId: row.repoId,
          path: row.path,
          kind: row.kind,
          executionHostId: row.executionHostId,
          identity: row.identity,
          openSessionIds: Array.isArray(row.openSessionIds)
            ? row.openSessionIds.filter((id): id is string => typeof id === 'string')
            : [],
          removedAt: row.removedAt
        })
      }
    }
  } catch {
    // Missing or unreadable file: start empty; a re-add must never fail because of this.
  }
  return stored
}

function saveStored(): void {
  const path = ledgerPath()
  if (!path || !stored) {
    return
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const oldest = Date.now() - REMOVED_PROJECT_RETENTION_MS
    const rows = [...stored.values()].filter((row) => row.removedAt >= oldest)
    writeFileAtomically(
      path,
      `${JSON.stringify({ version: 1, removed: rows }, null, 2)}
`,
      {
        mode: 0o600
      }
    )
  } catch (error) {
    console.warn('[projects] could not save the removed-project ledger', error)
  }
}

/** Git: the root commit(s), so a re-clone of the same repository matches and another repository at the
 *  same path does not. Folder: the directory's device + inode, so a recreated folder does not match. */
export async function readProjectIdentity(
  path: string,
  kind: 'git' | 'folder'
): Promise<string | null> {
  try {
    if (kind === 'git') {
      const { stdout } = await gitExecFileAsync(['rev-list', '--max-parents=0', 'HEAD'], {
        cwd: path
      })
      const roots = String(stdout).split(/\s+/).filter(Boolean).sort()
      return roots.length > 0 ? `git:${roots.join(',')}` : null
    }
    const info = await stat(path, { bigint: true })
    return info.isDirectory() && info.ino !== 0n ? `folder:${info.dev}:${info.ino}` : null
  } catch {
    return null
  }
}

/** Call before the project row is deleted (`openSessionIds`: the chats with an open tab right now); call the returned function once teardown has finished. */
export function beginProjectRemoval(
  repo: Pick<Repo, 'id' | 'path' | 'kind' | 'executionHostId' | 'connectionId'>,
  readIdentity: typeof readProjectIdentity = readProjectIdentity,
  openSessionIds: readonly string[] = []
): () => void {
  let finish = (): void => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const kind = repo.kind ?? 'git'
  const tombstone = readIdentity(repo.path, kind).then((identity) => {
    const value: RemovedProjectTombstone = {
      repoId: repo.id,
      path: repo.path,
      kind,
      executionHostId: getRepoExecutionHostId(repo),
      identity,
      openSessionIds
    }
    if (identity !== null) {
      loadStored().set(repo.id, { ...value, removedAt: Date.now() })
      saveStored()
    }
    return value
  })
  removed.set(repo.id, { tombstone, settled })
  return finish
}

/** Tombstones of removed projects; each resolves only after that removal has finished its teardown,
 *  so chats are never moved while the removal is still closing chats by the old id. */
export async function settledRemovedProjects(): Promise<RemovedProjectTombstone[]> {
  const live = await Promise.all(
    [...removed.values()].map(async (entry) => {
      await entry.settled
      return entry.tombstone
    })
  )
  // Rows from before an app restart; a project removed in this session is already in `live`.
  const seen = new Set(live.map((tombstone) => tombstone.repoId))
  const oldest = Date.now() - REMOVED_PROJECT_RETENTION_MS
  const fromDisk = [...loadStored().values()].filter(
    (row) => !seen.has(row.repoId) && row.removedAt >= oldest
  )
  return [...live, ...fromDisk]
}

/** Once a removed project's chats were moved, it cannot be claimed again by another re-add. */
export function forgetRemovedProject(repoId: string): void {
  removed.delete(repoId)
  if (loadStored().delete(repoId)) {
    saveStored()
  }
}

/** Tests: keep the ledger file in a temp folder (null = no file). */
export function useRemovedProjectLedgerFile(path: string | null): void {
  ledgerFile = path
  stored = null
}

/** Tests: what an app restart does: memory is gone, the file stays. */
export function simulateAppRestartForTests(): void {
  removed.clear()
  stored = null
}

export function resetRemovedProjectLedgerForTests(): void {
  removed.clear()
  stored = null
  ledgerFile = null
}
