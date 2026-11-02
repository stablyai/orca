import {
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from '../../../../shared/program-status/facet'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'

// Bound retained facets across long sessions; evict the least recently changed first.
const MAX_PROGRAM_STATUS_FACETS = 1024

type StoredProgramStatus = {
  facet: ProgramStatusFacet
  /** Ordered lifecycle state; chunk facets retain only their last report. */
  working?: boolean
  /** New working evidence can supersede a hook-settled turn. */
  workingSince?: number
  /** A prompt hook claimed the latest working run. */
  promptClaimed?: boolean
  /** The user typed since the run began: an interrupt, or the next prompt, which the rest cannot be. */
  inputSinceWorking?: boolean
  /** The agent the latest ordered state came from. */
  agentType?: string
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
  noteState(
    paneKey: string,
    { state, agentType }: Pick<ParsedAgentStatusPayload, 'state' | 'agentType'>,
    at: number
  ): number | undefined {
    const stored = this.byPaneKey.get(paneKey)
    if (stored === undefined) {
      return undefined
    }
    stored.agentType = agentType
    if (state === 'working' && stored.working !== true) {
      stored.workingSince = at
      stored.promptClaimed = false
      stored.inputSinceWorking = false
    }
    stored.working = state === 'working'
    return stored.workingSince
  }

  /** A submitted prompt claims the latest working run unless one already did, in which case the
   *  prompt belongs to a run not yet reported. The run may already have rested. */
  claimPrompt(paneKey: string): boolean {
    const stored = this.byPaneKey.get(paneKey)
    if (stored?.workingSince === undefined || stored.promptClaimed) {
      return false
    }
    stored.promptClaimed = true
    return true
  }

  noteInput(paneKey: string): void {
    const stored = this.byPaneKey.get(paneKey)
    if (stored?.workingSince !== undefined) {
      stored.inputSinceWorking = true
    }
  }

  /** The agent's claimed run went idle with no result and no input: a prompt hook blocked the prompt. */
  claimedRunRestedWithoutResult(paneKey: string, agentType: string): boolean {
    const stored = this.byPaneKey.get(paneKey)
    return (
      stored?.promptClaimed === true &&
      stored.inputSinceWorking !== true &&
      stored.agentType === agentType &&
      stored.working === false &&
      stored.facet.state === 'idle'
    )
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
