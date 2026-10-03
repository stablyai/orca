// A chat's status projection at its fold's tip, kept for one (fold, epoch, seq, fence): the status
// feed and the stored state (journal-session-state.ts) read the same one, so a commit renders and
// projects the whole chat once.

import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

export type JournalStatusProjectionState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

type Cached = {
  fold: JournalReducerState
  epoch: string
  sequence: number
  fence: number | undefined
  state: JournalStatusProjectionState
}

export class JournalStatusProjection {
  private cached: Cached | null = null

  constructor(private readonly fold: () => JournalReducerState) {}

  /** The projection under this fence; the fence moves when a child ends, the tip does not. */
  at(fence: number | undefined): JournalStatusProjectionState {
    const tip = this.atTip()
    return tip && tip.fence === fence ? tip.state : this.project(fence)
  }

  /** A failed append's projection read a row that never committed. */
  invalidate(): void {
    this.cached = null
  }

  private atTip(): Cached | null {
    const fold = this.fold()
    const cached = this.cached
    return cached &&
      cached.fold === fold &&
      cached.epoch === fold.epoch &&
      cached.sequence === fold.lastSequence
      ? cached
      : null
  }

  private project(fence: number | undefined): JournalStatusProjectionState {
    const fold = this.fold()
    const snapshot = renderJournalState(fold)
    const state = projectStructuredAgentSessionStatusState(
      snapshot.items,
      snapshot.submissions,
      fence
    )
    this.cached = { fold, epoch: fold.epoch, sequence: fold.lastSequence, fence, state }
    return state
  }
}
