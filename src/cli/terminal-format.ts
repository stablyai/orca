import type {
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeTerminalWait
} from '../shared/runtime-types'

export function formatTerminalList(result: RuntimeTerminalListResult): string {
  if (result.terminals.length === 0) {
    return 'No live terminals.'
  }
  const body = result.terminals
    .map(
      (terminal) =>
        `${terminal.handle}  ${terminal.title ?? '(untitled)'}  ${terminal.connected ? 'connected' : 'disconnected'}  ${terminal.worktreePath}\n${terminal.preview ? `preview: ${terminal.preview}` : 'preview: <empty>'}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.terminals.length} of ${result.totalCount}`
    : body
}

export function formatTerminalShow(result: { terminal: RuntimeTerminalShow }): string {
  const terminal = result.terminal
  return [
    `handle: ${terminal.handle}`,
    `title: ${terminal.title ?? '(untitled)'}`,
    `worktree: ${terminal.worktreePath}`,
    `branch: ${terminal.branch}`,
    `leaf: ${terminal.leafId}`,
    `ptyId: ${terminal.ptyId ?? 'none'}`,
    `connected: ${terminal.connected}`,
    `writable: ${terminal.writable}`,
    `preview: ${terminal.preview || '<empty>'}`
  ].join('\n')
}

export function formatTerminalRead(result: { terminal: RuntimeTerminalRead }): string {
  const terminal = result.terminal
  const oldestCursor =
    typeof terminal.oldestCursor === 'string' ? [`oldest cursor: ${terminal.oldestCursor}`] : []
  const latestCursor =
    typeof terminal.latestCursor === 'string' ? [`latest cursor: ${terminal.latestCursor}`] : []
  const limitedWarning = formatTerminalReadLimitedWarning(terminal)
  const header = [
    `handle: ${terminal.handle}`,
    `status: ${terminal.status}`,
    ...(terminal.nextCursor !== null ? [`cursor: ${terminal.nextCursor}`] : []),
    ...oldestCursor,
    ...latestCursor,
    ...(terminal.truncated ? ['warning: older output is no longer retained'] : []),
    ...(limitedWarning ? [limitedWarning] : [])
  ]
  return [...header, '', ...terminal.tail].join('\n')
}

function formatTerminalReadLimitedWarning(terminal: RuntimeTerminalRead): string | null {
  if (!terminal.limited) {
    return null
  }
  if (
    typeof terminal.nextCursor === 'string' &&
    typeof terminal.latestCursor === 'string' &&
    terminal.nextCursor !== terminal.latestCursor
  ) {
    return `warning: output limited; continue with --cursor ${terminal.nextCursor}`
  }
  if (
    typeof terminal.oldestCursor === 'string' &&
    typeof terminal.latestCursor === 'string' &&
    terminal.oldestCursor !== terminal.latestCursor
  ) {
    // A tail preview's next cursor is already latest, so oldestCursor is the retained history entry point.
    return `warning: output limited; page retained output with --cursor ${terminal.oldestCursor} --limit <count>`
  }
  return 'warning: output limited'
}

export function formatTerminalSend(result: { send: RuntimeTerminalSend }): string {
  return `Sent ${result.send.bytesWritten} bytes to ${result.send.handle}.`
}

export function formatTerminalRename(result: { rename: RuntimeTerminalRename }): string {
  return result.rename.title
    ? `Renamed terminal ${result.rename.handle} to "${result.rename.title}".`
    : `Cleared title for terminal ${result.rename.handle}.`
}

export function formatTerminalCreate(result: { terminal: RuntimeTerminalCreate }): string {
  const titleNote = result.terminal.title ? ` (title: "${result.terminal.title}")` : ''
  const surfaceNote = result.terminal.surface ? ` [${result.terminal.surface}]` : ''
  return `Created terminal ${result.terminal.handle}${titleNote}${surfaceNote}`
}

export function formatTerminalSplit(result: { split: RuntimeTerminalSplit }): string {
  return `Split pane ${result.split.handle} in tab ${result.split.tabId}`
}

export function formatTerminalFocus(result: { focus: RuntimeTerminalFocus }): string {
  return `Focused terminal ${result.focus.handle} (tab ${result.focus.tabId}).`
}

export function formatTerminalClose(result: { close: RuntimeTerminalClose }): string {
  const ptyNote = result.close.ptyKilled ? ' PTY killed.' : ''
  return `Closed terminal ${result.close.handle}.${ptyNote}`
}

export function formatTerminalWait(result: { wait: RuntimeTerminalWait }): string {
  const lines = [
    `handle: ${result.wait.handle}`,
    `condition: ${result.wait.condition}`,
    `satisfied: ${result.wait.satisfied}`,
    `status: ${result.wait.status}`,
    `exitCode: ${result.wait.exitCode ?? 'null'}`
  ]
  if (result.wait.blockedReason) {
    lines.push(`blockedReason: ${result.wait.blockedReason}`)
  }
  return lines.join('\n')
}
