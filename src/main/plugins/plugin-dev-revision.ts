import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

// Why a run nonce: counters restart at 0, and a guest URL from the last run must not look current.
const RUN_NONCE = randomBytes(4).toString('hex')
const revisions = new Map<string, number>()

/** The dev watcher calls this for every reported change under a dev plugin root. */
export function bumpPluginDevRevision(root: string): void {
  const key = resolve(root)
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
}

const editCounts = new Map<string, number>()

/** A watcher event batch under `root`; unlike setup catch-up bumps, it counts as file changes. */
export function recordPluginDevEdit(root: string, changedPaths: number): void {
  bumpPluginDevRevision(root)
  const key = resolve(root)
  editCounts.set(key, (editCounts.get(key) ?? 0) + Math.max(1, changedPaths))
}

/** File changes the dev watcher reported under `root` this run. */
export function pluginDevChangeCount(root: string): number {
  return editCounts.get(resolve(root)) ?? 0
}

/** Changes exactly when the dev watcher saw an edit under `root`; never hashes the tree. */
export function pluginDevRevision(root: string): string {
  return `dev-${RUN_NONCE}-${revisions.get(resolve(root)) ?? 0}`
}

/** The `rev` of a plugin's frame guest URLs: an update or a dev edit (even asset-only) changes it. */
export function pluginFrameContentRevision(plugin: {
  contentHash?: string | null
  rootDir: string
}): string {
  return plugin.contentHash ? plugin.contentHash.slice(0, 16) : pluginDevRevision(plugin.rootDir)
}
