import {
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from '../../../../shared/program-status/facet'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

// Why a bound: one entry per pane that ever ran an OSC 7501 program; stale panes age out first.
const MAX_PROGRAM_STATUS_FACETS = 1024

type StoredProgramStatus = {
  facet: ProgramStatusFacet
  /** From the ordered lifecycle reports; a facet holds only a chunk's last one. */
  working?: boolean
  /** When the program last entered `working`: evidence of new work after a hook-settled turn. */
  workingSince?: number
}

/**
 * Each pane's latest OSC 7501 facet, kept apart from the status rows. A row's producer (hook or OSC)
 * owns its state; this map is owned by the OSC 7501 channel alone and is stitched onto rows only as
 * they are published, so it is never persisted and never compared as a row change. It also keeps when
 * the program last entered `working` (noteState), which relies on a chunk's facet arriving first.
 */
export class ProgramStatusFacetStore {
  private readonly byPaneKey = new Map<string, StoredProgramStatus>()

  /** Returns whether the pane's facet changed. `null` removes it. */
  set(paneKey: string, facet: ProgramStatusFacet | null): boolean {
    const previous = this.byPaneKey.get(paneKey)
    if (facet === null) {
      return this.byPaneKey.delete(paneKey)
    }
    if (programStatusFacetsEqual(previous?.facet, facet)) {
      return false
    }
    this.byPaneKey.delete(paneKey)
    this.byPaneKey.set(paneKey, { ...previous, facet })
    if (this.byPaneKey.size > MAX_PROGRAM_STATUS_FACETS) {
      const oldest = this.byPaneKey.keys().next().value
      if (oldest !== undefined) {
        this.byPaneKey.delete(oldest)
      }
    }
    return true
  }

  get(paneKey: string): ProgramStatusFacet | undefined {
    return this.byPaneKey.get(paneKey)?.facet
  }

  /** Records the program's projected lifecycle state, in report order, and returns when it last
   *  entered `working`. */
  noteState(paneKey: string, state: AgentStatusState, at: number): number | undefined {
    const stored = this.byPaneKey.get(paneKey)
    if (stored === undefined) {
      return undefined
    }
    if (state === 'working' && stored.working !== true) {
      stored.workingSince = at
    }
    stored.working = state === 'working'
    return stored.workingSince
  }

  delete(paneKey: string): void {
    this.byPaneKey.delete(paneKey)
  }

  /** A pane remint keeps the program's facet with its row. */
  move(fromPaneKey: string, toPaneKey: string): void {
    const stored = this.byPaneKey.get(fromPaneKey)
    if (stored === undefined) {
      return
    }
    this.byPaneKey.delete(fromPaneKey)
    this.byPaneKey.set(toPaneKey, stored)
  }

  clear(): void {
    this.byPaneKey.clear()
  }

  /** A copy of `row` carrying its pane's facet. The stored row is never mutated. */
  stitch<T extends { paneKey: string; programStatus?: ProgramStatusFacet }>(row: T): T {
    const facet = this.byPaneKey.get(row.paneKey)?.facet
    if (facet === row.programStatus) {
      return row
    }
    if (facet === undefined) {
      const { programStatus: _stale, ...rest } = row
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dropping one optional key keeps T's shape.
      return rest as T
    }
    return { ...row, programStatus: facet }
  }
}
