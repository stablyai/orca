import { open } from 'node:fs/promises'

const ROLLOUT_READ_LIMIT = 64 * 1024

/** Read the Codex session id without streaming the full rollout transcript. */
export async function readCodexRolloutSessionMetaId(filePath: string): Promise<string | null> {
  // A listed rollout may vanish before it is read — Codex prunes and rewrites
  // these files. One missing file must not abort the whole scan.
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(ROLLOUT_READ_LIMIT)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]?.trim()
    if (!firstLine) {
      return null
    }
    const record = JSON.parse(firstLine) as {
      type?: unknown
      id?: unknown
      session_id?: unknown
      thread_id?: unknown
      payload?: { id?: unknown; session_id?: unknown; thread_id?: unknown }
    }
    if (record.type !== 'session_meta') {
      return null
    }
    const id =
      record.payload?.id ??
      record.payload?.session_id ??
      record.payload?.thread_id ??
      record.id ??
      record.session_id ??
      record.thread_id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}
