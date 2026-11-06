import { MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES } from './codex-structured-item-stream-bounds'

export const CODEX_ITEM_STREAM_TYPES = {
  'item/agentMessage/delta': 'agentMessage',
  'item/plan/delta': 'plan',
  'item/commandExecution/outputDelta': 'commandExecution',
  'item/fileChange/outputDelta': 'fileChange',
  'item/reasoning/summaryTextDelta': 'reasoning',
  'item/reasoning/textDelta': 'reasoning'
} as const

export const PATCH_UPDATED_METHOD = 'item/fileChange/patchUpdated'
export const REASONING_PART_METHOD = 'item/reasoning/summaryPartAdded'
export const TERMINAL_INTERACTION_METHOD = 'item/commandExecution/terminalInteraction'

export function readCodexItemStreamRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readCodexItemStreamString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function codexPatchChangeBytes(changes: readonly unknown[]): number {
  let total = 0
  for (const change of changes) {
    const record = readCodexItemStreamRecord(change)
    const path = readCodexItemStreamString(record, 'path')
    const diff = readCodexItemStreamString(record, 'diff')
    if (path && diff) {
      total += Buffer.byteLength(path, 'utf8') + Buffer.byteLength(diff, 'utf8') + 1
      if (total > MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES) {
        return total
      }
    }
  }
  return total
}
