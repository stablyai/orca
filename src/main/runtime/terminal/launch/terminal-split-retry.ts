import { BoundedMap } from '../../../../shared/bounded-map'
import { TerminalSplitOutcomeError } from '../../../../shared/terminal-split-outcome'
import { SPLIT_PANE_WAIT_TIMEOUT_MESSAGE } from './terminal-split-wait-timeout'

/** Where main asked the window to split; a retry answers from it without asking again. */
export type RendererSplit = {
  tabId: string
  paneRuntimeId: number
}

type RendererSplitEntry = {
  split: RendererSplit
  recordedAt: number
}

const MAX_RENDERER_SPLITS = 128
const RENDERER_SPLIT_TTL_MS = 30 * 60_000

/** Window-made splits keyed by the new pane's leaf id, so a retry joins the split instead of repeating it. */
export class RendererSplitLedger {
  private readonly entries = new BoundedMap<string, RendererSplitEntry>({
    maxEntries: MAX_RENDERER_SPLITS
  })

  constructor(private readonly now: () => number = Date.now) {}

  record(leafId: string, split: RendererSplit): void {
    this.prune()
    this.entries.set(leafId, { split, recordedAt: this.now() })
  }

  get(leafId: string): RendererSplit | null {
    this.prune()
    return this.entries.peek(leafId)?.split ?? null
  }

  private prune(): void {
    const cutoff = this.now() - RENDERER_SPLIT_TTL_MS
    for (const [leafId, entry] of this.entries.entries()) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(leafId)
      }
    }
  }
}

const LIST_BEFORE_SPLITTING =
  'Before splitting again, check `orca terminal list --json` for a pane with this leafId: its command may already be running.'

export function splitPanePendingError(tabId: string, leafId: string): TerminalSplitOutcomeError {
  return new TerminalSplitOutcomeError(
    `${SPLIT_PANE_WAIT_TIMEOUT_MESSAGE}: pane ${leafId} in tab ${tabId} may still open and run its command.`,
    {
      splitId: leafId,
      tabId,
      splitMayStillComplete: true,
      nextSteps: [
        `Do not split again. With an orca CLI that has --retry-split, re-run the same command with --retry-split ${leafId} to wait for this pane and get its handle.`,
        LIST_BEFORE_SPLITTING
      ]
    }
  )
}

export function splitRetryUnknownError(tabId: string, leafId: string): TerminalSplitOutcomeError {
  return new TerminalSplitOutcomeError(
    `This Orca host has no record of split ${leafId} from this terminal; it was not split again.`,
    { splitId: leafId, tabId, splitMayStillComplete: false, nextSteps: [LIST_BEFORE_SPLITTING] }
  )
}
