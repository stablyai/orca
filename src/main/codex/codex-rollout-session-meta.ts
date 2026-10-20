import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../native-chat/wsl-transcript-fs-gate'

const ROLLOUT_READ_LIMIT = 64 * 1024
const LONG_META_READ_LIMIT = 1024 * 1024

/** Where a reverted or forked rollout's inherited prefix lives: a ROLLOUT id, not a thread id. */
export type CodexRolloutHistoryBase = { rolloutId: string; endByteOffset: number }

export type CodexRolloutSessionMeta = {
  id: string
  historyBase: CodexRolloutHistoryBase | null
}

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
  return (await readCodexRolloutSessionMeta(filePath, signal, priority))?.id ?? null
}

export async function readCodexRolloutSessionMeta(
  filePath: string,
  signal?: AbortSignal,
  priority: WslTranscriptFsTaskPriority = 'exact'
): Promise<CodexRolloutSessionMeta | null> {
  let head: Buffer
  try {
    // Gated, not raw fs: AI Vault hands this every scan candidate, including
    // `\\wsl.localhost\...` rollouts, so a stalled distro must fail on the
    // transcript gate's deadline instead of blocking the scan (#15453). A
    // listed rollout may also vanish before it is read — Codex prunes and
    // rewrites these files — and one missing file must not abort the scan.
    head = await readTranscriptSlice(filePath, 0, ROLLOUT_READ_LIMIT, priority, signal)
    // Why: session_meta carries base_instructions, which can outgrow the first read.
    if (head.length === ROLLOUT_READ_LIMIT && !head.includes(0x0a)) {
      head = await readTranscriptSlice(filePath, 0, LONG_META_READ_LIMIT, priority, signal)
    }
  } catch (error) {
    // A cancelled scan must surface as cancellation, not as one more rollout
    // that could not prove its id.
    if (signal?.aborted) {
      throw error
    }
    return null
  }
  const firstLine = head.toString('utf8').split(/\r?\n/, 1)[0]?.trim()
  return firstLine ? parseCodexSessionMetaLine(firstLine) : null
}

export function parseCodexSessionMetaLine(line: string): CodexRolloutSessionMeta | null {
  let record: Map<string, unknown>
  try {
    record = objectFields(JSON.parse(line))
  } catch {
    return null
  }
  if (record.get('type') !== 'session_meta') {
    return null
  }
  const payload = objectFields(record.get('payload'))
  const id = [payload, record]
    .flatMap((fields) => ['id', 'session_id', 'thread_id'].map((key) => fields.get(key)))
    .find((value) => value !== undefined && value !== null)
  if (typeof id !== 'string' || id.length === 0) {
    return null
  }
  return { id, historyBase: readCodexHistoryBase(payload.get('history_base')) }
}

function objectFields(value: unknown): Map<string, unknown> {
  return new Map(value && typeof value === 'object' ? Object.entries(value) : [])
}

export function readCodexHistoryBase(value: unknown): CodexRolloutHistoryBase | null {
  const fields = objectFields(value)
  const rolloutId = fields.get('thread_id')
  const endByteOffset = fields.get('end_byte_offset')
  return typeof rolloutId === 'string' &&
    rolloutId.length > 0 &&
    typeof endByteOffset === 'number' &&
    Number.isSafeInteger(endByteOffset) &&
    endByteOffset >= 0
    ? { rolloutId: rolloutId.toLowerCase(), endByteOffset }
    : null
}
