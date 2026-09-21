import type { PtySpawnResult } from '../../../providers/types'
import { ptySizes } from './visibility-state'

export type PtyGrid = { cols: number; rows: number }

function positiveGrid(cols: unknown, rows: unknown): PtyGrid | undefined {
  return typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0
    ? { cols, rows }
    : undefined
}

/** Pre-attach seed for `ptySizes`. Daemon PTYs can emit before spawn() resolves, so a genuinely
 *  fresh session must record its geometry now or early bytes parse at xterm's 80x24 default.
 *  An attach must not seed: a pane that mounted while hidden reports xterm's unmeasured default,
 *  and the live PTY's real grid is either already cached or arrives with the attach result. */
export function shouldSeedPreAttachPtySize(args: {
  isFreshSessionId: boolean
  hasCachedSize: boolean
  requestIsUnmeasured: boolean
}): boolean {
  return args.isFreshSessionId || (!args.hasCachedSize && !args.requestIsUnmeasured)
}

/** Grid to record for a settled spawn. Daemon and relay attach never resize the session they hand
 *  back, so on a reattach the requested grid describes the pane, not the live process — take the
 *  provider's proven grid, then the size main already held, before trusting the request. */
export function resolveCommittedPtySize(args: {
  result: Pick<PtySpawnResult, 'isReattach' | 'attachedGrid' | 'snapshotCols' | 'snapshotRows'>
  requested: PtyGrid
  cachedBeforeAttach: PtyGrid | undefined
}): PtyGrid {
  if (args.result.isReattach !== true) {
    return args.requested
  }
  return (
    positiveGrid(args.result.attachedGrid?.cols, args.result.attachedGrid?.rows) ??
    positiveGrid(args.result.snapshotCols, args.result.snapshotRows) ??
    positiveGrid(args.cachedBeforeAttach?.cols, args.cachedBeforeAttach?.rows) ??
    args.requested
  )
}

type HeadlessReflow = ((ptyId: string, cols: number, rows: number) => void) | undefined

/** Reflow main's model onto the committed grid, whatever the spawn was. Why unconditional: live
 *  bytes can lazily create the model at the 80x24 default before the reply arrives, a seed skips an
 *  existing model, and the pre-attach seed is now withheld for unmeasured attaches, so a session the
 *  daemon re-created instead of attaching would otherwise keep the default forever. */
export function reflowHeadlessTerminalToCommittedGrid(args: {
  result: Pick<PtySpawnResult, 'id'>
  committedSize: PtyGrid
  reflowHeadlessTerminalToPtyGrid: HeadlessReflow
}): void {
  args.reflowHeadlessTerminalToPtyGrid?.(
    args.result.id,
    args.committedSize.cols,
    args.committedSize.rows
  )
}

/** Record the settled grid, then reflow the model onto it. Callers that seed the model between the
 *  two steps (ipc spawn commit) call the halves separately. */
export function commitAttachedPtySize(args: {
  result: Pick<
    PtySpawnResult,
    'id' | 'isReattach' | 'attachedGrid' | 'snapshotCols' | 'snapshotRows'
  >
  requested: PtyGrid
  cachedBeforeAttach: PtyGrid | undefined
  reflowHeadlessTerminalToPtyGrid: HeadlessReflow
}): PtyGrid {
  const committedSize = resolveCommittedPtySize(args)
  ptySizes.set(args.result.id, committedSize)
  reflowHeadlessTerminalToCommittedGrid({ ...args, committedSize })
  return committedSize
}
