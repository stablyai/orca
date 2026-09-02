import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { WslShellProcessAnchor } from '../../shared/wsl-shell-process-anchor'
import type {
  WslGuestProcessInventory,
  WslGuestProcessRow
} from './wsl-guest-process-inventory-parser'

export type WslGuestProcessAnchor = WslShellProcessAnchor

export type WslGuestForegroundResolution =
  | { status: 'live'; processName: string | null; anchor: WslGuestProcessAnchor }
  | { status: 'unverifiable'; reason: string }

export type WslGuestProcessIndexes = {
  byPid: ReadonlyMap<number, WslGuestProcessRow>
  byForegroundGroup: ReadonlyMap<string, readonly WslGuestProcessRow[]>
  multiplexerRows: readonly WslGuestProcessRow[]
}

function normalizeTty(tty: string): string {
  return tty.startsWith('/dev/') ? tty : tty === '?' ? '' : `/dev/${tty}`
}

function foregroundGroupKey(pgid: number, tty: string): string {
  return `${pgid}\u0000${normalizeTty(tty)}`
}

const isMultiplexerCommand = (command: string): boolean =>
  /(?:^|\s)(?:tmux|screen)(?:\s|$)/.test(command)

/** Build the indexes shared by every pane resolution for one inventory. */
export function createWslGuestProcessIndexes(
  inventory: WslGuestProcessInventory
): WslGuestProcessIndexes {
  const byPid = new Map<number, WslGuestProcessRow>()
  const groups = new Map<string, WslGuestProcessRow[]>()
  const multiplexerRows: WslGuestProcessRow[] = []
  for (const row of inventory.rows) {
    // Preserve the resolver's historical `rows.find(pid)` first-match rule.
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
    const key = foregroundGroupKey(row.pgid, row.tty)
    const group = groups.get(key)
    if (group) {
      group.push(row)
    } else {
      groups.set(key, [row])
    }
    if (isMultiplexerCommand(row.command)) {
      multiplexerRows.push(row)
    }
  }
  return { byPid, byForegroundGroup: groups, multiplexerRows }
}

/** Correlate one shell anchor to its foreground group and strict agent recognizer. */
export function resolveWslGuestForegroundProcess(
  inventory: WslGuestProcessInventory,
  anchor: WslGuestProcessAnchor,
  indexes: WslGuestProcessIndexes = createWslGuestProcessIndexes(inventory)
): WslGuestForegroundResolution {
  if (inventory.distro.toLowerCase() !== anchor.distro.toLowerCase()) {
    return { status: 'unverifiable', reason: 'distro_mismatch' }
  }
  if (inventory.bootId !== anchor.bootId) {
    return { status: 'unverifiable', reason: 'boot_id_mismatch' }
  }
  const shell = indexes.byPid.get(anchor.shellPid)
  if (!shell) {
    return { status: 'unverifiable', reason: 'anchor_missing' }
  }
  const tty = normalizeTty(shell.tty)
  if (!tty || (anchor.tty !== undefined && normalizeTty(anchor.tty) !== tty)) {
    return { status: 'unverifiable', reason: 'tty_mismatch' }
  }
  if (shell.startTimeTicks !== anchor.shellStartTime) {
    return { status: 'unverifiable', reason: 'pid_reused' }
  }
  if (shell.tpgid <= 0) {
    return { status: 'unverifiable', reason: 'foreground_group_missing' }
  }
  const group = indexes.byForegroundGroup.get(foregroundGroupKey(shell.tpgid, tty)) ?? []
  if (group.length === 0) {
    return { status: 'unverifiable', reason: 'foreground_group_missing' }
  }
  // Multiplexers move the real command to another PTY/session. Without a
  // session-aware anchor, the outer shell cannot make a truthful claim.
  if (group.some((row) => isMultiplexerCommand(row.command))) {
    return { status: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  const isShellDescendant = (row: WslGuestProcessRow): boolean => {
    const seen = new Set<number>()
    let current: WslGuestProcessRow | undefined = row
    while (current && !seen.has(current.pid)) {
      if (current.pid === shell.pid) {
        return true
      }
      seen.add(current.pid)
      current = indexes.byPid.get(current.ppid)
    }
    return false
  }
  if (
    indexes.multiplexerRows.some(
      (row) => row.pid !== shell.pid && normalizeTty(row.tty) !== tty && isShellDescendant(row)
    )
  ) {
    return { status: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  const recognized = group
    .map((row) => recognizeAgentProcessFromCommandLine(row.command)?.processName ?? null)
    .filter((name): name is string => name !== null)
  if (new Set(recognized).size > 1) {
    return { status: 'unverifiable', reason: 'ambiguous_foreground_group' }
  }
  const nextAnchor = {
    ...anchor,
    bootId: inventory.bootId,
    shellStartTime: shell.startTimeTicks,
    tty
  }
  return { status: 'live', processName: recognized[0] ?? null, anchor: nextAnchor }
}
