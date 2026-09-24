import { JevClient } from './compaction/fast-jev/client.js'
import { compact } from './compaction/fast-jev/compact.js'
import type { Message, ToolUse, ToolResult, CompactResult } from './compaction/fast-jev/types.js'

export type CompactTerminalOptions = {
  /** If true, perform fast-jev semantic compaction. */
  compact?: boolean
  /** Characters of tool result to keep when truncated. Default 200. */
  truncateHeadChars?: number
  /** Number of recent messages never pruned. Default 4. */
  preserveRecentMessages?: number
}

/**
 * Parses terminal lines into Message objects for Fast-Jev compaction.
 */
export function parseTerminalToMessages(lines: string[]): Message[] {
  const messages: Message[] = []
  let currentRole: 'user' | 'assistant' = 'assistant'
  let currentText: string[] = []
  const currentToolUses: ToolUse[] = []
  const currentToolResults: ToolResult[] = []

  let pendingTool: {
    id: string
    name: string
    input: Record<string, unknown>
    output: string[]
  } | null = null

  const flushMessage = () => {
    if (pendingTool) {
      currentToolUses.push({
        tool_use_id: pendingTool.id,
        tool: pendingTool.name,
        input: pendingTool.input
      })
      currentToolResults.push({
        tool_use_id: pendingTool.id,
        text: pendingTool.output.join('\n')
      })
      pendingTool = null
    }

    if (currentText.length > 0 || currentToolUses.length > 0 || currentToolResults.length > 0) {
      messages.push({
        role: currentRole,
        text: currentText.join('\n'),
        toolUses: [...currentToolUses],
        ...(currentToolResults.length > 0 ? { toolResults: [...currentToolResults] } : {})
      })
      currentText = []
      currentToolUses.length = 0
      currentToolResults.length = 0
    }
  }

  let toolIdCounter = 1

  for (const line of lines) {
    const toolUseMatch = line.match(
      /(?:(?:Running|Tool(?:\s+Use)?|Command|Action):\s*([a-zA-Z0-9_-]+)|^\$\s+([a-zA-Z0-9_.-]+))/i
    )
    if (toolUseMatch) {
      if (pendingTool) {
        currentToolUses.push({
          tool_use_id: pendingTool.id,
          tool: pendingTool.name,
          input: pendingTool.input
        })
        currentToolResults.push({
          tool_use_id: pendingTool.id,
          text: pendingTool.output.join('\n')
        })
      }
      const toolName = toolUseMatch[1] || toolUseMatch[2] || 'command'
      pendingTool = {
        id: `t${toolIdCounter++}`,
        name: toolName,
        input: { command: line.trim() },
        output: []
      }
      continue
    }

    const userPromptMatch = line.match(/^(?:>|\[User\]|User:)\s*(.*)$/)
    if (userPromptMatch) {
      flushMessage()
      currentRole = 'user'
      currentText.push(userPromptMatch[1] || line)
      flushMessage()
      currentRole = 'assistant'
      continue
    }

    if (pendingTool) {
      pendingTool.output.push(line)
    } else {
      currentText.push(line)
    }
  }

  flushMessage()

  if (messages.length === 0) {
    messages.push({
      role: 'assistant',
      text: lines.join('\n'),
      toolUses: []
    })
  }

  return messages
}

/**
 * Performs fast local heuristic compaction when Jev API is unavailable.
 */
export function compactTerminalHeuristic(
  messages: readonly Message[],
  preserveRecent = 4,
  headChars = 200
): {
  messages: Message[]
  stats: { charsBefore: number; charsAfter: number; resultsDropped: number }
} {
  let charsBefore = 0
  let charsAfter = 0
  let resultsDropped = 0

  const n = messages.length
  const compacted: Message[] = []

  for (let i = 0; i < n; i++) {
    const msg = messages[i]
    charsBefore += msg.text.length
    for (const tu of msg.toolUses) {
      charsBefore += JSON.stringify(tu.input).length
    }
    for (const tr of msg.toolResults ?? []) {
      charsBefore += tr.text.length
    }

    const isPinned = i === 0 || i >= n - preserveRecent
    if (isPinned) {
      compacted.push(msg)
      charsAfter += msg.text.length
      for (const tu of msg.toolUses) {
        charsAfter += JSON.stringify(tu.input).length
      }
      for (const tr of msg.toolResults ?? []) {
        charsAfter += tr.text.length
      }
      continue
    }

    const newToolResults = (msg.toolResults ?? []).map((result) => {
      if (result.text.length > headChars + 100) {
        resultsDropped++
        const head = result.text.slice(0, headChars)
        const truncatedChars = result.text.length - headChars
        return {
          ...result,
          text: `${head}\n[fast-jev-compaction truncated ${truncatedChars} chars; essential code/result preserved]`
        }
      }
      return result
    })

    const newMsg: Message = {
      role: msg.role,
      text: msg.text,
      toolUses: msg.toolUses,
      ...(newToolResults.length > 0 ? { toolResults: newToolResults } : {})
    }

    charsAfter += newMsg.text.length
    for (const tu of newMsg.toolUses) {
      charsAfter += JSON.stringify(tu.input).length
    }
    for (const tr of newToolResults) {
      charsAfter += tr.text.length
    }

    compacted.push(newMsg)
  }

  return {
    messages: compacted,
    stats: { charsBefore, charsAfter, resultsDropped }
  }
}

/**
 * Formats compacted Message objects back into human-readable terminal lines.
 */
export function renderMessagesHuman(messages: readonly Message[]): string[] {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`❯ ${msg.text}`)
    } else if (msg.text.trim().length > 0) {
      lines.push(msg.text)
    }

    for (let i = 0; i < msg.toolUses.length; i++) {
      const toolUse = msg.toolUses[i]
      const toolResult = (msg.toolResults ?? []).find((r) => r.tool_use_id === toolUse.tool_use_id)
      const cmdStr = (toolUse.input?.command as string) || JSON.stringify(toolUse.input)

      lines.push(`┌── Tool: ${toolUse.tool} ───────────────────────────────────────────────────`)
      lines.push(`│ $ ${cmdStr}`)
      if (toolResult && toolResult.text.trim().length > 0) {
        lines.push(`├──────────────────────────────────────────────────────────────────────`)
        const resLines = toolResult.text.split('\n')
        for (const rl of resLines) {
          lines.push(`│ ${rl}`)
        }
      }
      lines.push(`└──────────────────────────────────────────────────────────────────────`)
    }
  }

  return lines
}

/**
 * Executes semantic compaction via fast-jev, falling back to local heuristic.
 */
export async function executeFastJevCompaction(
  lines: string[],
  options: CompactTerminalOptions = {}
): Promise<{ lines: string[]; summary: string }> {
  const messages = parseTerminalToMessages(lines)
  const client = new JevClient()
  const headChars = options.truncateHeadChars ?? 200
  const preserveRecent = options.preserveRecentMessages ?? 4

  let compactedMessages: Message[] = messages
  let summary = ''

  if (client.isConfigured) {
    try {
      const result: CompactResult = await compact(messages, client, {
        preserveRecentMessages: preserveRecent,
        truncateHeadChars: headChars
      })
      compactedMessages = result.messages
      const pct = Math.round(
        ((result.stats.charsBefore - result.stats.charsAfter) / (result.stats.charsBefore || 1)) *
          100
      )
      summary = `[fast-jev-compaction: ${result.stats.charsBefore} -> ${result.stats.charsAfter} chars (-${pct}%), ${result.stats.kept} calls kept, ${result.stats.resultsDropped} results pruned]`
    } catch {
      const heuristic = compactTerminalHeuristic(messages, preserveRecent, headChars)
      compactedMessages = heuristic.messages
      const pct = Math.round(
        ((heuristic.stats.charsBefore - heuristic.stats.charsAfter) /
          (heuristic.stats.charsBefore || 1)) *
          100
      )
      summary = `[fast-jev-compaction (heuristic): ${heuristic.stats.charsBefore} -> ${heuristic.stats.charsAfter} chars (-${pct}%), ${heuristic.stats.resultsDropped} results pruned]`
    }
  } else {
    const heuristic = compactTerminalHeuristic(messages, preserveRecent, headChars)
    compactedMessages = heuristic.messages
    const pct = Math.round(
      ((heuristic.stats.charsBefore - heuristic.stats.charsAfter) /
        (heuristic.stats.charsBefore || 1)) *
        100
    )
    summary = `[fast-jev-compaction (local): ${heuristic.stats.charsBefore} -> ${heuristic.stats.charsAfter} chars (-${pct}%), ${heuristic.stats.resultsDropped} results pruned]`
  }

  return {
    lines: renderMessagesHuman(compactedMessages),
    summary
  }
}
