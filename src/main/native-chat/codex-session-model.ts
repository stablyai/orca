import { open } from 'node:fs/promises'
import type { NativeChatSessionModel } from '../../shared/native-chat-types'

const MAX_MODEL_SCAN_BYTES = 2 * 1024 * 1024

function readSessionModelFromLine(line: string): NativeChatSessionModel | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.type !== 'turn_context' || typeof record.payload !== 'object' || !record.payload) {
    return null
  }
  const payload = record.payload as Record<string, unknown>
  if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
    return null
  }
  const reasoningEffort =
    typeof payload.effort === 'string' && payload.effort.trim().length > 0
      ? payload.effort.trim()
      : undefined
  return {
    model: payload.model.trim(),
    ...(reasoningEffort ? { reasoningEffort } : {})
  }
}

/** Read the latest model actually recorded by a Codex session. */
export async function readCodexSessionModel(
  filePath: string
): Promise<NativeChatSessionModel | undefined> {
  const file = await open(filePath, 'r')
  try {
    const stats = await file.stat()
    const length = Math.min(stats.size, MAX_MODEL_SCAN_BYTES)
    if (length <= 0) {
      return undefined
    }
    const start = stats.size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      const sessionModel = readSessionModelFromLine(lines[index].trim())
      if (sessionModel) {
        return sessionModel
      }
    }
    return undefined
  } finally {
    await file.close()
  }
}
