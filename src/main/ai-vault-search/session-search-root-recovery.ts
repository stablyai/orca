/**
 * What each pass saw of each root, and whether one of them owes a full sweep.
 *
 * A cycle reads the newest N per agent, so on its own a root that comes back —
 * a volume remounted, an SSH home reachable again — would give up its newest
 * transcript and leave the rest unreachable for the life of the process. The
 * one observation carried between passes is which real roots listed transcripts;
 * a root listing them again where the previous pass listed none is a recovery.
 *
 * Nothing here is health and nothing here decides a deletion: the retirement
 * walk owns that and needs no memory at all. This exists only to decide when a
 * cheap cycle is not enough.
 */
export class SessionSearchRootRecovery {
  /** Null until a pass has recorded one; an empty set is a real observation. */
  private previous: ReadonlySet<string> | null = null
  /** Roots whose recovery already bought a sweep; cleared by a stable pass. */
  private rearmed = new Set<string>()

  /** What the previous pass listed, or undefined when there has not been one. */
  get previousRootsWithFiles(): ReadonlySet<string> | undefined {
    return this.previous ?? undefined
  }

  /**
   * Records a pass and answers whether it bought a full sweep.
   *
   * `mayArm` is false for a sweep: it has no previous pass to compare against
   * on the first pass of a process, where every root holding files would read
   * as a recovery and arm the sweep that just ran.
   *
   * The re-arm is bounded to once per recovery. A root has to be listed healthy
   * on the pass after the one that re-armed before it can buy another sweep, so
   * a root flapping every interval costs one sweep rather than one a flap.
   */
  observe(rootsWithFiles: ReadonlySet<string>, mayArm: boolean): boolean {
    const previous = this.previous
    let owesSweep = false
    for (const root of rootsWithFiles) {
      if (previous !== null && previous.has(root)) {
        // Healthy on two passes running: the next recovery may re-arm again.
        this.rearmed.delete(root)
        continue
      }
      if (previous === null || this.rearmed.has(root)) {
        continue
      }
      this.rearmed.add(root)
      owesSweep ||= mayArm
    }
    this.previous = rootsWithFiles
    return owesSweep
  }

  /** After `clear()`: the index is empty, so no pass has observed anything. */
  reset(): void {
    this.previous = null
    this.rearmed = new Set()
  }
}
