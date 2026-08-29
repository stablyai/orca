import { PTY_LIVE_NOTE, describeUnconfirmedStop } from '../shared/pty-liveness-verdict'
import { structuredChatPtyWriteRefusalCopy } from '../shared/agent-session-pty-write-refusal-copy'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalListHostScope,
  RuntimeTerminalListResult,
  RuntimeTerminalVisualLayout,
  RuntimeTerminalVisualLayoutNode,
  RuntimeTerminalVisualPaneNode,
  RuntimeTerminalVisualTab,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeTerminalWait
} from '../shared/runtime-types'

export function formatTerminalList(result: RuntimeTerminalListResult): string {
  const scope = formatTerminalListHostScope(result.hostScope)
  if (result.terminals.length === 0) {
    return `No terminals listed.\n${scope}`
  }
  const body = result.terminals
    .map(
      (terminal) =>
        `${terminal.handle}  ${terminal.title ?? '(untitled)'}  ${terminal.connected ? 'connected' : 'disconnected'}  host=${terminal.executionHostId ?? 'unverifiable'}  ${terminal.worktreePath}\n${terminal.preview ? `preview: ${terminal.preview}` : 'preview: <empty>'}`
    )
    .join('\n\n')
  const visualLayout = formatTerminalVisualLayouts(result.visualLayouts)
  const bodyWithLayout = visualLayout ? `${body}\n\nvisual layout:\n${visualLayout}` : body
  const bodyWithScope = `${bodyWithLayout}\n\n${scope}`
  return result.truncated
    ? `${bodyWithScope}\ntruncated: showing ${result.terminals.length} of ${result.totalCount}`
    : bodyWithScope
}

// Why: a listing that does not say what it covers reads as absolute, and an
// absent scope means the host is too old to know — not that it covered everything.
function formatTerminalListHostScope(scope: RuntimeTerminalListHostScope | undefined): string {
  if (!scope) {
    return 'scope: unverifiable — this host does not report which hosts it lists'
  }
  const covered = scope.hostIds.length > 0 ? scope.hostIds.join(', ') : 'none'
  const omitted =
    scope.omittedHostIds.length > 0 ? ` — not covered: ${scope.omittedHostIds.join(', ')}` : ''
  return `scope: ${covered}${omitted}`
}

function formatTerminalVisualLayouts(
  layouts: readonly RuntimeTerminalVisualLayout[] | undefined
): string | null {
  if (!layouts || layouts.length === 0) {
    return null
  }
  return layouts
    .map((layout) =>
      [
        `worktree: ${layout.worktreePath || layout.worktreeId}`,
        ...formatVisualLayoutNode(layout.root, 0)
      ].join('\n')
    )
    .join('\n\n')
}

function formatVisualLayoutNode(node: RuntimeTerminalVisualLayoutNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  if (node.type === 'split') {
    return [
      `${indent}split ${node.direction}`,
      ...formatVisualLayoutNode(node.first, depth + 1),
      ...formatVisualLayoutNode(node.second, depth + 1)
    ]
  }
  return [
    `${indent}group ${node.groupId ?? '(default)'}`,
    ...node.tabs.flatMap((tab) => formatVisualTab(tab, depth + 1))
  ]
}

function formatVisualTab(tab: RuntimeTerminalVisualTab, depth: number): string[] {
  const indent = '  '.repeat(depth)
  return [
    `${indent}tab ${tab.tabId}  ${tab.title ?? '(untitled)'}`,
    ...formatVisualPaneNode(tab.panes, depth + 1)
  ]
}

function formatVisualPaneNode(node: RuntimeTerminalVisualPaneNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  if (node.type === 'pane-split') {
    return [
      `${indent}pane split ${node.direction}`,
      ...formatVisualPaneNode(node.first, depth + 1),
      ...formatVisualPaneNode(node.second, depth + 1)
    ]
  }
  const marker = node.active ? '* ' : '  '
  return [
    `${indent}${marker}${node.handle}  ${node.title ?? '(untitled)'}  tab=${node.tabId} leaf=${node.leafId}`
  ]
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
    // Why listed above the preview: the preview is where a reader would otherwise have to
    // spot the prompt by eye, which is the work this line exists to remove.
    `agentWait: ${formatAgentWait(terminal.agentWait)}`,
    `preview: ${terminal.preview || '<empty>'}`
  ].join('\n')
}

function formatAgentWait(agentWait: RuntimeTerminalShow['agentWait']): string {
  if (agentWait === undefined) {
    return 'unknown (not evaluated)'
  }
  if (!agentWait) {
    return 'none'
  }
  return `${agentWait.reason ?? 'interactive prompt'} (via ${agentWait.source})`
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
    ...(terminal.source ? [`source: ${terminal.source}`] : []),
    ...(terminal.draft ? [`draft: ${JSON.stringify(terminal.draft)}`] : []),
    ...(terminal.nextCursor !== null ? [`cursor: ${terminal.nextCursor}`] : []),
    ...oldestCursor,
    ...latestCursor,
    ...(terminal.truncated ? ['warning: older output is no longer retained'] : []),
    ...(limitedWarning ? [limitedWarning] : []),
    // Why: the caller asked for the rendered screen; say plainly that this is not it rather
    // than let repaint fragments be read as what the terminal displayed.
    ...(terminal.source === 'screen-unavailable'
      ? [
          'warning: no rendered screen was available, so this is accumulated output; repainted lines may appear as stacked fragments'
        ]
      : [])
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
  if (result.send.agentSessionRefusal) {
    const copy = structuredChatPtyWriteRefusalCopy(result.send.agentSessionRefusal, 'terminal-send')
    if (copy) {
      return copy
    }
  }
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
  const warningNote = result.terminal.warning ? `\nwarning: ${result.terminal.warning}` : ''
  return `Created terminal ${result.terminal.handle}${titleNote}${surfaceNote}${warningNote}`
}

export function formatTerminalSplit(result: { split: RuntimeTerminalSplit }): string {
  return `Split pane ${result.split.handle} in tab ${result.split.tabId}`
}

export function formatTerminalFocus(result: { focus: RuntimeTerminalFocus }): string {
  if (result.focus.navigated === false) {
    return `Focus request for terminal ${result.focus.handle} was superseded or host navigation was skipped (tab ${result.focus.tabId}).`
  }
  return `Focused terminal ${result.focus.handle} (tab ${result.focus.tabId}).`
}

/** "PTY killed." is a claim of observed death, so only a confirmed kill earns it. */
function describePtyStop(close: RuntimeTerminalClose): string {
  if (close.ptyKilled) {
    return ' PTY killed.'
  }
  if (close.ptyStopVerdict === 'live') {
    return ` ${PTY_LIVE_NOTE}`
  }
  if (close.ptyStopVerdict === 'unverifiable') {
    return ` ${describeUnconfirmedStop(close.ptyStopReason ?? 'its host could not be reached')}`
  }
  return ''
}

export function formatTerminalClose(result: { close: RuntimeTerminalClose }): string {
  if (result.close.closeMode === 'tab') {
    return `Closed terminal tab ${result.close.tabId} (${result.close.handle}).`
  }
  return `Closed terminal ${result.close.handle}.${describePtyStop(result.close)}`
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
