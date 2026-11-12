import { existsSync } from 'node:fs'
import { isTerminalOscLinkRanges } from '../../../../shared/terminal/links/terminal-osc-link-ranges'
import { readTerminalHistoryJsonAsync } from '../storage/terminal-history-file-reader'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from '../storage/terminal-history-file-limits'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import type { TerminalCheckpointFile } from '../../protocol/daemon-checkpoint-file'
import type { TerminalModes } from '../../protocol/terminal-modes'
import { parseTerminalOwner } from '../../../../shared/terminal/pty/lifecycle/terminal-owner'

export type TerminalHistoryCheckpointRead =
  | { status: 'missing' }
  | { status: 'readable'; checkpoint: TerminalCheckpointFile }
  | { status: 'unreadable' }

export async function readTerminalHistoryCheckpoint(
  path: string,
  signal?: AbortSignal
): Promise<TerminalHistoryCheckpointRead> {
  signal?.throwIfAborted()
  if (!existsSync(path)) {
    return { status: 'missing' }
  }
  try {
    const value = await readTerminalHistoryJsonAsync(
      path,
      TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
      signal
    )
    signal?.throwIfAborted()
    return isTerminalCheckpointFile(value)
      ? { status: 'readable', checkpoint: value }
      : { status: 'unreadable' }
  } catch {
    signal?.throwIfAborted()
    return { status: 'unreadable' }
  }
}

export function isTerminalCheckpointFile(value: unknown): value is TerminalCheckpointFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const checkpoint = value as Partial<TerminalCheckpointFile>
  return (
    typeof checkpoint.snapshotAnsi === 'string' &&
    typeof checkpoint.scrollbackAnsi === 'string' &&
    typeof checkpoint.rehydrateSequences === 'string' &&
    (checkpoint.cwd === null || typeof checkpoint.cwd === 'string') &&
    isValidTerminalHistorySize(checkpoint.cols, checkpoint.rows) &&
    isTerminalModes(checkpoint.modes) &&
    isNonNegativeSafeInteger(checkpoint.scrollbackLines) &&
    (checkpoint.generation === undefined || isNonNegativeSafeInteger(checkpoint.generation)) &&
    (checkpoint.pendingOutputSeq === undefined ||
      isNonNegativeSafeInteger(checkpoint.pendingOutputSeq)) &&
    typeof checkpoint.checkpointedAt === 'string' &&
    (checkpoint.oscLinks === undefined || isTerminalOscLinkRanges(checkpoint.oscLinks)) &&
    (checkpoint.pendingEscapeTailAnsi === undefined ||
      typeof checkpoint.pendingEscapeTailAnsi === 'string') &&
    (checkpoint.lastTitle === undefined || typeof checkpoint.lastTitle === 'string') &&
    (checkpoint.terminalOwner === undefined ||
      parseTerminalOwner(checkpoint.terminalOwner) !== undefined)
  )
}

function isTerminalModes(value: unknown): value is TerminalModes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const modes = value as Partial<TerminalModes>
  return (
    typeof modes.bracketedPaste === 'boolean' &&
    typeof modes.mouseTracking === 'boolean' &&
    typeof modes.applicationCursor === 'boolean' &&
    typeof modes.alternateScreen === 'boolean' &&
    (modes.mouseTrackingMode === undefined ||
      ['none', 'x10', 'vt200', 'drag', 'any'].includes(modes.mouseTrackingMode)) &&
    (modes.sgrMouseMode === undefined || typeof modes.sgrMouseMode === 'boolean') &&
    (modes.sgrMousePixelsMode === undefined || typeof modes.sgrMousePixelsMode === 'boolean') &&
    (modes.kittyKeyboardFlags === undefined || isNonNegativeSafeInteger(modes.kittyKeyboardFlags))
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
