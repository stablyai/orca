import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../native-chat/wsl-transcript-fs-gate'

const ROLLOUT_READ_LIMIT = 64 * 1024

/**
 * Read the Codex session id without streaming the full rollout transcript.
 * Defaults to `exact` because the live-resume proof is interactive; the AI
 * Vault scan passes `scan` so a bulk sweep cannot starve it.
 */
export async function readCodexRolloutSessionMetaId(
  filePath: string,
  signal?: AbortSignal,
  priority: WslTranscriptFsTaskPriority = 'exact'
): Promise<string | null> {
  let head: Buffer
  try {
    // Gated, not raw fs: AI Vault hands this every scan candidate, including
    // `\\wsl.localhost\...` rollouts, so a stalled distro must fail on the
    // transcript gate's deadline instead of blocking the scan (#15453). A
    // listed rollout may also vanish before it is read — Codex prunes and
    // rewrites these files — and one missing file must not abort the scan.
    head = await readTranscriptSlice(filePath, 0, ROLLOUT_READ_LIMIT, priority, signal)
  } catch (error) {
    // A cancelled scan must surface as cancellation, not as one more rollout
    // that could not prove its id.
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
