/** How Claude closed a permission prompt, from what its transcript records for that tool call
 *  (probes 2026-11-10/11, Claude 2.1.322): the hook decision it took, written as soon as it takes
 *  it, and the tool_result: a hook's deny message verbatim, the user's No, the 2:00 safety-check
 *  block, or the command's own output, which is an error when an allowed command fails. Hook events
 *  do not say this: a deny or a No fires no PostToolUse or PostToolUseFailure. */
import { open, stat, type FileHandle } from 'node:fs/promises'
import type { WorkerApprovalOutcome } from '../../../../../shared/orchestration/approvals/worker-approval-payload'

export type ClaudeToolResult = { isError: boolean; text: string }
/** What the transcript holds for one call so far: the hook decision Claude took, then its result. */
export type ClaudeToolRecord = {
  hookDecision: 'allow' | 'deny' | null
  result: ClaudeToolResult | null
}
export type ClaudeToolClose = 'hook-denied' | 'user-denied' | 'auto-denied' | 'ran' | 'other'

// Why a tail: the newest tool call's result is at the end of a transcript that can be many MB.
const TAIL_BYTES = 512 * 1024
const USER_DENIED = "The user doesn't want to proceed with this tool use"
const AUTO_DENIED = 'denied by a built-in Claude Code safety check'

/** Null until the transcript holds either for this call, or unless the path is a regular file: a FIFO
 *  or device would never finish a read. */
export async function readClaudeToolRecord(
  transcriptPath: string,
  toolUseId: string
): Promise<ClaudeToolRecord | null> {
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
    const record: ClaudeToolRecord = { hookDecision: null, result: null }
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      const entry = line.includes(toolUseId) ? parseLine(line) : null
      record.hookDecision ??= hookDecisionIn(entry, toolUseId)
      record.result ??= toolResultIn(entry, toolUseId)
    }
    return record.hookDecision || record.result ? record : null
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** `{type: 'attachment', attachment: {type: 'hook_permission_decision', decision, toolUseID}}`. */
function hookDecisionIn(entry: unknown, toolUseId: string): 'allow' | 'deny' | null {
  const attachment = isRecord(entry) && isRecord(entry.attachment) ? entry.attachment : null
  if (
    attachment?.type !== 'hook_permission_decision' ||
    attachment.toolUseID !== toolUseId ||
    (attachment.decision !== 'allow' && attachment.decision !== 'deny')
  ) {
    return null
  }
  return attachment.decision
}

function toolResultIn(entry: unknown, toolUseId: string): ClaudeToolResult | null {
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

/** Whether Claude took Orca's hook answer for this call. Its record of the hook decision says so
 *  outright, before the tool even runs; without one (an older Claude), only a result that answer
 *  alone gives: our deny text, or, after an allow, anything but a person's No or the auto-block,
 *  since an allowed command that fails records an error result too. */
export function claudeTookHookAnswer(
  record: ClaudeToolRecord,
  decision: 'allow' | 'deny',
  denyMessage: string
): boolean {
  if (record.hookDecision) {
    return record.hookDecision === decision
  }
  if (!record.result) {
    return false
  }
  const close = claudeToolClose(record.result, decision === 'deny' ? denyMessage : null)
  return decision === 'deny' ? close === 'hook-denied' : close === 'ran' || close === 'other'
}

// How each tool_result names a close Orca did not make; null says no more than "closed".
const CLOSE_HOW: Record<ClaudeToolClose, Pick<WorkerApprovalOutcome, 'by' | 'decision'> | null> = {
  ran: { by: 'worker-terminal', decision: 'allow' },
  'user-denied': { by: 'worker-terminal', decision: 'deny' },
  'auto-denied': { by: 'auto', decision: 'deny' },
  'hook-denied': null,
  other: null
}

/** Who closed a prompt Orca did not answer, from this call's result; null when it names no one. */
export function claudeToolCloseHow(
  result: ClaudeToolResult | null
): Pick<WorkerApprovalOutcome, 'by' | 'decision'> | null {
  return result ? CLOSE_HOW[claudeToolClose(result, null)] : null
}
