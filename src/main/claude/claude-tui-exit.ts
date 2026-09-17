import { open } from 'node:fs/promises'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'

const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024
const TRANSCRIPT_TAIL_READ_LIMIT_BYTES = 4 * 1024 * 1024

type TranscriptLeafCandidate = { leafUuid: string; authoritative: boolean }

function validLeafUuid(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return null
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  return value === value.trim() && !hasControlCharacter ? value : null
}

export function readClaudeTranscriptEntryUuid(value: Record<string, unknown>): string | null {
  return value.isSidechain === true ||
    value.parent_tool_use_id != null ||
    (value.type !== 'user' && value.type !== 'assistant')
    ? null
    : validLeafUuid(value.uuid)
}

function readLeafCandidate(line: string): TranscriptLeafCandidate | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    const lastPromptLeaf = value.type === 'last-prompt' ? validLeafUuid(value.leafUuid) : null
    if (lastPromptLeaf) {
      return { leafUuid: lastPromptLeaf, authoritative: true }
    }
    const messageLeaf = readClaudeTranscriptEntryUuid(value)
    return messageLeaf ? { leafUuid: messageLeaf, authoritative: false } : null
  } catch {
    return null
  }
}

export async function* readClaudeTranscriptTailLines(
  transcriptPath: string
): AsyncGenerator<string> {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let position = size
    let suffix: Buffer[] = []
    let scanned = 0
    while (position > 0 && scanned < TRANSCRIPT_TAIL_READ_LIMIT_BYTES) {
      const length = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position)
      position -= length
      scanned += length
      const allocation = Buffer.allocUnsafe(length)
      const { bytesRead } = await file.read(allocation, 0, length, position)
      if (bytesRead !== length) {
        return
      }
      const buffer = allocation.subarray(0, bytesRead)
      let end = buffer.length
      for (let newline = buffer.lastIndexOf(0x0a, end - 1); newline !== -1;) {
        const part = buffer.subarray(newline + 1, end)
        const line =
          suffix.length === 0
            ? part.toString('utf8')
            : Buffer.concat([part, ...suffix]).toString('utf8')
        suffix = []
        if (line.trim()) {
          yield line.trim()
        }
        end = newline
        newline = end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1
      }
      if (end > 0) {
        suffix.unshift(buffer.subarray(0, end))
      }
    }
    if (position === 0 && suffix.length > 0) {
      const line = Buffer.concat(suffix).toString('utf8').trim()
      if (line) {
        yield line
      }
    }
  } finally {
    await file.close()
  }
}

export async function readClaudeTranscriptLeafUuid(transcriptPath: string): Promise<string | null> {
  let fallback: string | null = null
  for await (const line of readClaudeTranscriptTailLines(transcriptPath)) {
    const candidate = readLeafCandidate(line)
    if (!candidate) {
      continue
    }
    if (candidate.authoritative) {
      return candidate.leafUuid
    }
    fallback ??= candidate.leafUuid
  }
  return fallback
}

export type ClaudeTuiChildExit = {
  pid: number
  exitCode: number | null
  signal: string | null
}

export async function completeClaudeTuiExit(input: {
  childPid: number
  waitForChildExit: () => Promise<ClaudeTuiChildExit>
  sessionId: string
  transcriptPath: string
  fence: number
  persistHandle: (link: AgentSessionProviderHandleLink) => Promise<void>
  readLeafUuid?: (transcriptPath: string) => Promise<string | null>
  linkId?: string
  now?: () => number
}): Promise<{
  exit: ClaudeTuiChildExit
  transcriptPath: string
  link: AgentSessionProviderHandleLink
}> {
  const exit = await input.waitForChildExit()
  if (exit.pid !== input.childPid) {
    throw new Error('The observed process exit did not belong to the Claude child.')
  }
  const leafUuid = await (input.readLeafUuid ?? readClaudeTranscriptLeafUuid)(input.transcriptPath)
  if (!leafUuid) {
    throw new Error('The exited Claude TUI did not persist a resumable transcript leaf.')
  }
  const link = claudeProviderHandleLink({
    sessionId: input.sessionId,
    leafUuid,
    resumed: true,
    fence: input.fence,
    ...(input.linkId ? { linkId: input.linkId } : {}),
    observedAt: input.now?.() ?? Date.now()
  })
  await input.persistHandle(link)
  return { exit, transcriptPath: input.transcriptPath, link }
}
