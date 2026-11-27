import type { IPty } from 'node-pty'

/** Kept with the pty object itself, so a later process reusing the root pid cannot inherit it. */
const spawnStartedAtByPty = new WeakMap<IPty, number>()

export function recordConptySpawnStartedAt(proc: IPty, startedAtMs: number): void {
  spawnStartedAtByPty.set(proc, startedAtMs)
}

/** Wall-clock time just before the ConPTY spawn; every process the pane root started was created after it. */
export function conptySpawnStartedAtMs(proc: IPty): number | undefined {
  return spawnStartedAtByPty.get(proc)
}
