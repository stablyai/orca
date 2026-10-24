import {
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from '../../../../shared/program-status/facet'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

// Bound retained facets across long sessions; evict the least recently changed first.
const MAX_PROGRAM_STATUS_FACETS = 1024

type StoredProgramStatus = {
  facet: ProgramStatusFacet
  /** Ordered lifecycle state; chunk facets retain only their last report. */
  working?: boolean
  /** New working evidence can supersede a hook-settled turn. */
  workingSince?: number
}

/** Runtime-only facets are stitched at publication; noteState requires the chunk's facet first. */
export class ProgramStatusFacetStore {
  private readonly byPaneKey = new Map<string, StoredProgramStatus>()

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

  /** Return the latest working transition time while consuming states in report order. */
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

  /** Stitch without mutating the stored row. */
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
