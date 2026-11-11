/** How Claude closed a permission prompt, from the tool_result its transcript records for that tool
 *  call (probe 2026-11-10, Claude 2.1.322): a hook's deny message verbatim, the user's No, the 2:00
 *  safety-check block, or the command's own output. Hook events do not say this: a deny or a No
 *  fires no PostToolUse or PostToolUseFailure. */
import { open, stat, type FileHandle } from 'node:fs/promises'

export type ClaudeToolResult = { isError: boolean; text: string }
export type ClaudeToolClose = 'hook-denied' | 'user-denied' | 'auto-denied' | 'ran' | 'other'

// Why a tail: the newest tool call's result is at the end of a transcript that can be many MB.
const TAIL_BYTES = 512 * 1024
const USER_DENIED = "The user doesn't want to proceed with this tool use"
const AUTO_DENIED = 'denied by a built-in Claude Code safety check'

/** Null unless the path is a regular file: a FIFO or device would never finish a read. */
export async function readClaudeToolResult(
  transcriptPath: string,
  toolUseId: string
): Promise<ClaudeToolResult | null> {
  let file: FileHandle | null = null
  try {
    // Why stat before open: opening a FIFO waits for a writer.
    const stats = await stat(transcriptPath)
    if (!stats.isFile()) {
      return null
    }
    file = await open(transcriptPath, 'r')
    const length = Math.min(stats.size, TAIL_BYTES)
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(length),
      0,
      length,
      stats.size - length
    )
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    for (const line of lines.toReversed()) {
      const result = line.includes(toolUseId) ? toolResultIn(line, toolUseId) : null
      if (result) {
        return result
      }
    }
    return null
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
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
