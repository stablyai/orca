import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
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

/** Seed fresh geometry before early bytes arrive; unmeasured attaches must preserve the live PTY grid. */
export function shouldSeedPreAttachPtySize(args: {
  isFreshSessionId: boolean
  hasCachedSize: boolean
  requestIsUnmeasured: boolean
}): boolean {
  return args.isFreshSessionId || (!args.hasCachedSize && !args.requestIsUnmeasured)
}

/** Attach does not resize the PTY; prefer proven provider/cached geometry over the pane request. */
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

/** Early bytes may create an 80x24 model; always reflow because seeding skips an existing model. */
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

/** Commit geometry only after registration admits this incarnation. */
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
