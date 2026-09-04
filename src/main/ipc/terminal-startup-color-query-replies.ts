import {
  terminalOscColorQueryReply,
  type TerminalOscColorQueryReplyColors
} from '../../shared/terminal-osc-color-reply'

function normalizeTerminalColorQueryReplyColors(
  value: unknown
): TerminalOscColorQueryReplyColors | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as { foreground?: unknown; background?: unknown }
  const colors = {
    ...(typeof record.foreground === 'string' ? { foreground: record.foreground } : {}),
    ...(typeof record.background === 'string' ? { background: record.background } : {})
  }
  if (!terminalOscColorQueryReply(colors, 10) || !terminalOscColorQueryReply(colors, 11)) {
    return null
  }
  return colors
}

export function getStartupTerminalColorQueryReplyColors(args: {
  terminalColorQueryReplies?: unknown
}): TerminalOscColorQueryReplyColors | null {
  return normalizeTerminalColorQueryReplyColors(args.terminalColorQueryReplies)
}
