import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { agentKindSchema } from '../../shared/telemetry-events'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import {
  parseTerminalOscColorQuery,
  terminalOscColorQueryReplies,
  terminalOscColorQueryReply,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from '../../shared/terminal-osc-color-reply'

type StartupTerminalColorQueryProvider = {
  write(id: string, data: string): void
}

type StartupTerminalColorQueryReplyState = {
  colors: TerminalOscColorQueryReplyColors
  pending: string
  answeredSlots: Set<TerminalOscColorQuerySlot>
  timeout: ReturnType<typeof setTimeout>
}

const STARTUP_TERMINAL_COLOR_QUERY_REPLY_WINDOW_MS = 5_000
const STARTUP_TERMINAL_COLOR_QUERY_PENDING_CHARS = 64
const startupTerminalColorQueryRepliesByPty = new Map<string, StartupTerminalColorQueryReplyState>()

export function clearStartupTerminalColorQueryReplies(ptyId: string): void {
  const state = startupTerminalColorQueryRepliesByPty.get(ptyId)
  if (!state) {
    return
  }
  clearTimeout(state.timeout)
  startupTerminalColorQueryRepliesByPty.delete(ptyId)
}

export function moveStartupTerminalColorQueryReplies(fromPtyId: string, toPtyId: string): void {
  if (fromPtyId === toPtyId) {
    return
  }
  const state = startupTerminalColorQueryRepliesByPty.get(fromPtyId)
  if (!state) {
    return
  }
  startupTerminalColorQueryRepliesByPty.delete(fromPtyId)
  clearStartupTerminalColorQueryReplies(toPtyId)
  startupTerminalColorQueryRepliesByPty.set(toPtyId, state)
}

export function registerStartupTerminalColorQueryReplies(
  ptyId: string,
  colors: TerminalOscColorQueryReplyColors
): void {
  if (!terminalOscColorQueryReply(colors, 10) || !terminalOscColorQueryReply(colors, 11)) {
    return
  }
  clearStartupTerminalColorQueryReplies(ptyId)
  const timeout = setTimeout(
    () => clearStartupTerminalColorQueryReplies(ptyId),
    STARTUP_TERMINAL_COLOR_QUERY_REPLY_WINDOW_MS
  )
  timeout.unref?.()
  startupTerminalColorQueryRepliesByPty.set(ptyId, {
    colors,
    pending: '',
    answeredSlots: new Set(),
    timeout
  })
}

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

function shouldReplyToStartupTerminalColorQueries(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  if (isTuiAgent(args.launchAgent)) {
    return true
  }
  const agentKindParse =
    args.telemetry?.agent_kind !== undefined
      ? agentKindSchema.safeParse(args.telemetry.agent_kind)
      : null
  if (agentKindParse?.success && agentKindParse.data !== 'other') {
    return true
  }
  const command = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  return recognizeAgentProcessFromCommandLine(command) !== null
}

export function getStartupTerminalColorQueryReplyColors(args: {
  launchAgent?: unknown
  telemetry?: { agent_kind?: unknown } | undefined
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  terminalColorQueryReplies?: unknown
}): TerminalOscColorQueryReplyColors | null {
  if (!shouldReplyToStartupTerminalColorQueries(args)) {
    return null
  }
  return normalizeTerminalColorQueryReplyColors(args.terminalColorQueryReplies)
}

function writeStartupTerminalColorQueryReplies(
  ptyId: string,
  slots: readonly TerminalOscColorQuerySlot[],
  state: StartupTerminalColorQueryReplyState,
  getProvider: (ptyId: string) => StartupTerminalColorQueryProvider | undefined
): boolean {
  const replies = terminalOscColorQueryReplies(state.colors, slots)
  let provider: StartupTerminalColorQueryProvider | undefined
  try {
    provider = replies ? getProvider(ptyId) : undefined
  } catch {
    provider = undefined
  }
  if (!replies || !provider) {
    return false
  }
  try {
    for (const [index, reply] of replies.entries()) {
      const slot = slots[index]
      if (slot === undefined) {
        return false
      }
      provider.write(ptyId, reply)
      state.answeredSlots.add(slot)
    }
    return true
  } catch {
    return false
  }
}

export function answerStartupTerminalColorQueries(
  ptyId: string,
  data: string,
  getProvider: (ptyId: string) => StartupTerminalColorQueryProvider | undefined
): string {
  const state = startupTerminalColorQueryRepliesByPty.get(ptyId)
  if (!state || data.length === 0) {
    return data
  }
  const input = state.pending + data
  let pending = ''
  let output = ''
  let offset = 0
  while (offset < input.length) {
    const candidateIndex = input.indexOf('\x1b', offset)
    if (candidateIndex === -1) {
      output += input.slice(offset)
      break
    }
    output += input.slice(offset, candidateIndex)
    const query = parseTerminalOscColorQuery(input, candidateIndex)
    if (query.kind === 'none') {
      output += input[candidateIndex]
      offset = candidateIndex + 1
      continue
    }
    if (query.kind === 'partial') {
      const candidate = input.slice(candidateIndex)
      if (candidate.length <= STARTUP_TERMINAL_COLOR_QUERY_PENDING_CHARS) {
        pending = candidate
      } else {
        output += candidate
      }
      break
    }
    if (!writeStartupTerminalColorQueryReplies(ptyId, query.slots, state, getProvider)) {
      output += input.slice(candidateIndex, query.endIndex)
    }
    offset = query.endIndex
  }
  state.pending = pending
  if (state.answeredSlots.has(10) && state.answeredSlots.has(11)) {
    clearStartupTerminalColorQueryReplies(ptyId)
  }
  return output
}
