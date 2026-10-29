import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../native-chat/wsl-transcript-fs-gate'

const ROLLOUT_READ_LIMIT = 64 * 1024

/** Interactive resume uses exact priority; bulk AI Vault scans must not starve it. */
export async function readCodexRolloutSessionMetaId(
  filePath: string,
  signal?: AbortSignal,
  priority: WslTranscriptFsTaskPriority = 'exact'
): Promise<string | null> {
  let head: Buffer
  try {
    // The transcript gate bounds stalled WSL reads; missing or pruned rollouts cannot abort a scan (#15453).
    head = await readTranscriptSlice(filePath, 0, ROLLOUT_READ_LIMIT, priority, signal)
  } catch (error) {
    // Preserve cancellation instead of treating it as an unreadable rollout.
    if (signal?.aborted) {
      throw error
    }
    return null
  }
  const firstLine = head.toString('utf8').split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) {
    return null
  }
  try {
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
  }
}
