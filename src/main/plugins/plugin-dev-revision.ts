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

/** Changes exactly when the dev watcher saw an edit under `root`; never hashes the tree. */
export function pluginDevRevision(root: string): string {
  return `dev-${RUN_NONCE}-${revisions.get(resolve(root)) ?? 0}`
}
