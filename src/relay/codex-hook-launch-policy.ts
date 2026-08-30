import { parsePaneKey } from '../shared/stable-pane-id'
import { tokenizeStartupCommand } from '../shared/tui-agent-startup-shell'

function isPosixEnvAssignment(
  command: string,
  span: { start: number; end: number; divergesFromShell: boolean }
): boolean {
  return (
    !span.divergesFromShell && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(span.start, span.end))
  )
}

function hasOnlyHorizontalWhitespaceGaps(
  command: string,
  spans: readonly { start: number; end: number }[]
): boolean {
  let previousEnd = 0
  for (const span of spans) {
    if (!/^[\t ]*$/.test(command.slice(previousEnd, span.start))) {
      return false
    }
    previousEnd = span.end
  }
  return /^[\t ]*$/.test(command.slice(previousEnd))
}

export function hasCompleteRemoteAgentHookContext(args: {
  env: Record<string, string>
  paneKey: unknown
}): boolean {
  const paneKey = typeof args.paneKey === 'string' ? args.paneKey : ''
  return Boolean(
    args.env.ORCA_AGENT_HOOK_PORT?.trim() &&
    args.env.ORCA_AGENT_HOOK_TOKEN?.trim() &&
    paneKey &&
    args.env.ORCA_PANE_KEY === paneKey &&
    parsePaneKey(paneKey)
  )
}

export function isDirectPosixCodexCommand(command: string): boolean {
  const tokenized = tokenizeStartupCommand(command, 'posix')
  if (!tokenized.ok) {
    return false
  }
  const codexIndex = tokenized.tokens.indexOf('codex')
  const codexSpan = tokenized.spans[codexIndex]
  return Boolean(
    codexIndex !== -1 &&
    codexSpan &&
    command.slice(codexSpan.start, codexSpan.end) === 'codex' &&
    tokenized.spans.slice(0, codexIndex).every((span) => isPosixEnvAssignment(command, span)) &&
    tokenized.spans.every((span) => !span.divergesFromShell) &&
    hasOnlyHorizontalWhitespaceGaps(command, tokenized.spans)
  )
}
