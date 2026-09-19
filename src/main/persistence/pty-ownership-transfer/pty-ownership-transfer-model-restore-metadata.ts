import {
  isTerminalOscLinkRanges,
  type TerminalOscLinkRange
} from '../../../shared/terminal-osc-link-ranges'
import { parseTerminalKittyKeyboardFlags } from '../../../shared/terminal-kitty-keyboard-flags'

export type PtyOwnershipModelRestoreMetadata = {
  version: 1
  kittyKeyboardFlags?: number
  cwd?: string | null
  lastTitle?: string
  oscLinks?: TerminalOscLinkRange[]
  terminalOwner?: 'shell'
  pendingEscapeTailAnsi?: string
}

export function parsePtyOwnershipModelRestoreMetadata(
  value: unknown
): PtyOwnershipModelRestoreMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_model_restore_metadata_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    (record.kittyKeyboardFlags !== undefined &&
      parseTerminalKittyKeyboardFlags(record.kittyKeyboardFlags) === undefined) ||
    (record.cwd !== undefined && record.cwd !== null && typeof record.cwd !== 'string') ||
    (record.lastTitle !== undefined && typeof record.lastTitle !== 'string') ||
    (record.terminalOwner !== undefined && record.terminalOwner !== 'shell') ||
    (record.pendingEscapeTailAnsi !== undefined &&
      typeof record.pendingEscapeTailAnsi !== 'string') ||
    (record.oscLinks !== undefined && !isTerminalOscLinkRanges(record.oscLinks)) ||
    Buffer.byteLength(JSON.stringify(record), 'utf8') > 4 * 1024 * 1024
  ) {
    throw new Error('pty_ownership_transfer_model_restore_metadata_invalid')
  }
  return {
    version: 1,
    ...(record.kittyKeyboardFlags !== undefined
      ? { kittyKeyboardFlags: record.kittyKeyboardFlags as number }
      : {}),
    ...(record.cwd !== undefined ? { cwd: record.cwd as string | null } : {}),
    ...(record.lastTitle !== undefined ? { lastTitle: record.lastTitle as string } : {}),
    ...(record.terminalOwner !== undefined ? { terminalOwner: 'shell' as const } : {}),
    ...(record.pendingEscapeTailAnsi !== undefined
      ? { pendingEscapeTailAnsi: record.pendingEscapeTailAnsi as string }
      : {}),
    ...(record.oscLinks !== undefined
      ? { oscLinks: structuredClone(record.oscLinks as TerminalOscLinkRange[]) }
      : {})
  }
}
