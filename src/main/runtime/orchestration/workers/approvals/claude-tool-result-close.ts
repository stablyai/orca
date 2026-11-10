/** How Claude closed a permission prompt, from the tool_result its transcript records for that tool
 *  call (probe 2026-11-10, Claude 2.1.322): a hook's deny message verbatim, the user's No, the 2:00
 *  safety-check block, or the command's own output. Hook events do not say this: a deny or a No
 *  fires no PostToolUse or PostToolUseFailure. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export type ClaudeToolResult = { isError: boolean; text: string }
export type ClaudeToolClose = 'hook-denied' | 'user-denied' | 'auto-denied' | 'ran' | 'other'

// Why a tail: the newest tool call's result is at the end of a transcript that can be many MB.
const TAIL_BYTES = 512 * 1024
const USER_DENIED = "The user doesn't want to proceed with this tool use"
const AUTO_DENIED = 'denied by a built-in Claude Code safety check'

export function readClaudeToolResult(
  transcriptPath: string,
  toolUseId: string
): ClaudeToolResult | null {
  let fd: number | null = null
  try {
    fd = openSync(transcriptPath, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.includes(toolUseId))
    for (const line of lines.toReversed()) {
      const result = toolResultIn(line, toolUseId)
      if (result) {
        return result
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

function toolResultIn(line: string, toolUseId: string): ClaudeToolResult | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const content = isRecord(entry) && isRecord(entry.message) ? entry.message.content : null
  if (!Array.isArray(content)) {
    return null
  }
  for (const block of content) {
    if (isRecord(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId) {
      return { isError: block.is_error === true, text: textOf(block.content) }
    }
  }
  return null
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  return Array.isArray(content)
    ? content
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('')
    : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `ourDeny`: the message Orca's hook sent, so only that exact text is credited to Orca. */
export function claudeToolClose(result: ClaudeToolResult, ourDeny: string | null): ClaudeToolClose {
  if (!result.isError) {
    return 'ran'
  }
  if (ourDeny !== null && result.text.trim() === ourDeny.trim()) {
    return 'hook-denied'
  }
  if (result.text.startsWith(USER_DENIED)) {
    return 'user-denied'
  }
  return result.text.includes(AUTO_DENIED) ? 'auto-denied' : 'other'
}
