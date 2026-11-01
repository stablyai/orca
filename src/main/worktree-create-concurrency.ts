// Record disk competition during each create, excluding its adopted preparation.

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
  /** Exclude the preparation this create adopted from competing work. */
  adoptPreparation(work: PreparationWork): void
  /** End tracking; repeated calls return the same peaks. */
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
      // Before this item started, excluding it would leave the previous peak unchanged.
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
      preparations.delete(work)
    }
  }
  preparations.add(work)
  for (const create of creates) {
    observePreparations(create)
  }
  return work
}

export function trackPreparationWork<T>(operation: Promise<T>): Promise<T> {
  const work = beginPreparationWork()
  return operation.finally(() => work.end())
}

export function _resetWorktreeCreateConcurrencyForTests(): void {
  creates.clear()
  preparations.clear()
}
