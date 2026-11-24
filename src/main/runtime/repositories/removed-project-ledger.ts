import { stat } from 'node:fs/promises'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RemovedProjectTombstone } from '../../../shared/repository/orphaned-chat-rekey'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'

type Entry = { tombstone: Promise<RemovedProjectTombstone>; settled: Promise<void> }

/** Projects removed in this app session, so a re-add of the same project can move its chats. In
 *  memory only: after a restart nothing is re-keyed, which is the behavior before this ledger. */
const removed = new Map<string, Entry>()

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
  const tombstone = readIdentity(repo.path, kind).then((identity) => ({
    repoId: repo.id,
    path: repo.path,
    kind,
    executionHostId: getRepoExecutionHostId(repo),
    identity,
    openSessionIds
  }))
  removed.set(repo.id, { tombstone, settled })
  return finish
}

/** Tombstones of removed projects; each resolves only after that removal has finished its teardown,
 *  so chats are never moved while the removal is still closing chats by the old id. */
export function settledRemovedProjects(): Promise<RemovedProjectTombstone[]> {
  return Promise.all(
    [...removed.values()].map(async (entry) => {
      await entry.settled
      return entry.tombstone
    })
  )
}

/** Once a removed project's chats were moved, it cannot be claimed again by another re-add. */
export function forgetRemovedProject(repoId: string): void {
  removed.delete(repoId)
}

export function resetRemovedProjectLedgerForTests(): void {
  removed.clear()
}
