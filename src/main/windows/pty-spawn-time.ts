import type { IPty } from 'node-pty'

// Wall-clock start of each pane's spawn, held with the pane itself so a reused pid cannot overwrite it.
const spawnStartedAt = new WeakMap<IPty, number>()

export function markPtySpawnStarted<T extends IPty>(proc: T, startedAtMs: number): T {
  spawnStartedAt.set(proc, startedAtMs)
  return proc
}

export function ptySpawnStartedAtMs(proc: IPty): number | undefined {
  return spawnStartedAt.get(proc)
}
