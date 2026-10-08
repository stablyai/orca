// In-memory counts of worktree creates and prepared-checkout disk work running in this process, so
// a slow create can be read against what competed with it for the disk.

/** One prepared-checkout build or discard; its identity lets the create that used it leave it out. */
export type PreparationWork = { end(): void }

type InFlightCreate = {
  peakOtherCreates: number
  peakPreparations: number
  /** Per work item seen: the peak with that item left out. */
  peakPreparationsWithout: Map<PreparationWork, number>
  adopted: PreparationWork | undefined
}

export type WorktreeCreateConcurrency = {
  /** Most other creates seen running alongside this one. */
  otherCreates: number
  /** Most preparation work seen running at once, excluding the prepared checkout this create used. */
  preparations: number
}

export type WorktreeCreateInFlightHandle = {
  /** Leaves `work` out of this create's count: it is the prepared checkout this create waits on. */
  adoptPreparation(work: PreparationWork): void
  /** Ends this create's membership; later calls return the same counts. */
  end(): WorktreeCreateConcurrency
}

const creates = new Set<InFlightCreate>()
const preparations = new Set<PreparationWork>()

function observePreparations(create: InFlightCreate): void {
  const count = preparations.size
  for (const [work, peak] of create.peakPreparationsWithout) {
    create.peakPreparationsWithout.set(
      work,
      Math.max(peak, count - (preparations.has(work) ? 1 : 0))
    )
  }
  for (const work of preparations) {
    if (!create.peakPreparationsWithout.has(work)) {
      // Before it appeared, leaving it out changed nothing, so the plain peak so far applies.
      create.peakPreparationsWithout.set(work, Math.max(create.peakPreparations, count - 1))
    }
  }
  create.peakPreparations = Math.max(create.peakPreparations, count)
}

export function beginWorktreeCreate(): WorktreeCreateInFlightHandle {
  const entry: InFlightCreate = {
    peakOtherCreates: creates.size,
    peakPreparations: 0,
    peakPreparationsWithout: new Map(),
    adopted: undefined
  }
  for (const other of creates) {
    other.peakOtherCreates = Math.max(other.peakOtherCreates, creates.size)
  }
  observePreparations(entry)
  creates.add(entry)
  let result: WorktreeCreateConcurrency | undefined
  return {
    adoptPreparation(work) {
      entry.adopted = work
    },
    end() {
      if (!result) {
        creates.delete(entry)
        result = {
          otherCreates: entry.peakOtherCreates,
          preparations: entry.adopted
            ? (entry.peakPreparationsWithout.get(entry.adopted) ?? entry.peakPreparations)
            : entry.peakPreparations
        }
      }
      return result
    }
  }
}

export function beginPreparationWork(): PreparationWork {
  let ended = false
  const work: PreparationWork = {
    end() {
      if (ended) {
        return
      }
      ended = true
      // Peaks only rise when work starts, so ending needs no observation.
      preparations.delete(work)
    }
  }
  preparations.add(work)
  for (const create of creates) {
    observePreparations(create)
  }
  return work
}

/** Counts `operation` as preparation work until it settles. */
export function trackPreparationWork<T>(operation: Promise<T>): Promise<T> {
  const work = beginPreparationWork()
  return operation.finally(() => work.end())
}

export function _resetWorktreeCreateConcurrencyForTests(): void {
  creates.clear()
  preparations.clear()
}
