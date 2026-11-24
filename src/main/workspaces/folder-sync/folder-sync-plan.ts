import type {
  FolderSyncEntry,
  FolderSyncManifest
} from '../../../shared/project/folder-project-sync'

export type FolderSyncPair = [local: FolderSyncManifest, remote: FolderSyncManifest]

type FolderSyncChange = {
  path: string
  from: 0 | 1
  entry?: FolderSyncEntry
  previous?: FolderSyncEntry
}

function equal(a: FolderSyncEntry | undefined, b: FolderSyncEntry | undefined): boolean {
  return a?.kind === b?.kind && (a?.kind !== 'file' || (b?.kind === 'file' && a.hash === b.hash))
}

export function planFolderSync(
  before: FolderSyncPair,
  after: FolderSyncPair
): {
  changes: FolderSyncChange[]
  conflicts: string[]
} {
  const localBefore = new Map(before[0])
  const remoteBefore = new Map(before[1])
  const localAfter = new Map(after[0])
  const remoteAfter = new Map(after[1])
  const paths = new Set([
    ...localBefore.keys(),
    ...remoteBefore.keys(),
    ...localAfter.keys(),
    ...remoteAfter.keys()
  ])
  const changes: FolderSyncChange[] = []
  const conflicts: string[] = []
  const blocked = new Set(
    [...after[0], ...after[1]].filter(([, entry]) => entry.kind === 'blocked').map(([path]) => path)
  )
  for (const path of paths) {
    if (blocked.has(path)) {
      conflicts.push(path)
      continue
    }
    if (hasBlockedParent(path, blocked)) {
      conflicts.push(path)
      continue
    }
    const local = localAfter.get(path)
    const remote = remoteAfter.get(path)
    if (equal(local, remote)) {
      continue
    }
    const oldLocal = localBefore.get(path)
    const oldRemote = remoteBefore.get(path)
    const localChanged = !equal(local, oldLocal)
    const remoteChanged = !equal(remote, oldRemote)
    if (!localChanged && !remoteChanged) {
      continue
    }
    const from = localChanged ? 0 : 1
    const [entry, previous] = from === 0 ? [local, remote] : [remote, local]
    if (
      (localChanged && remoteChanged) ||
      (entry && previous && entry.kind !== previous.kind) ||
      (previous && !equal(oldLocal, oldRemote))
    ) {
      conflicts.push(path)
    } else {
      changes.push({ path, from, entry, previous })
    }
  }

  const planned = new Set(changes.map(({ path, from }) => JSON.stringify([from, path])))
  for (const change of changes.slice()) {
    if (!change.entry) {
      continue
    }
    const from = change.from === 0 ? localAfter : remoteAfter
    const to = change.from === 0 ? remoteAfter : localAfter
    for (const parent of parentPaths(change.path)) {
      const key = JSON.stringify([change.from, parent])
      const entry = from.get(parent)
      if (entry?.kind === 'directory' && !to.has(parent) && !planned.has(key)) {
        changes.push({ path: parent, from: change.from, entry })
        planned.add(key)
      }
    }
  }
  // Parents before creates, children before removes.
  changes.sort(
    (a, b) =>
      Number(!a.entry) - Number(!b.entry) ||
      (a.entry ? a.path.length - b.path.length : b.path.length - a.path.length)
  )
  return { changes, conflicts }
}

function hasBlockedParent(path: string, blocked: ReadonlySet<string>): boolean {
  return parentPaths(path).some((parent) => blocked.has(parent))
}

function parentPaths(path: string): string[] {
  const parents: string[] = []
  for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
    parents.push(path.slice(0, end))
  }
  return parents
}
