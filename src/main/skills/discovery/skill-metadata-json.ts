import { open, stat } from 'node:fs/promises'

const MAX_SKILL_METADATA_BYTES = 4 * 1024 * 1024

export async function readSkillMetadataFile(
  pathValue: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    signal?.throwIfAborted()
    const fileStat = await stat(pathValue)
    signal?.throwIfAborted()
    if (!fileStat.isFile() || fileStat.size > MAX_SKILL_METADATA_BYTES) {
      return null
    }
    const file = await open(pathValue, 'r')
    try {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(fileStat.size)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      signal?.throwIfAborted()
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

export function parseSkillMetadataJsonObject(
  content: string | null
): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const cleaned = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
    const parsed: unknown = JSON.parse(cleaned)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
