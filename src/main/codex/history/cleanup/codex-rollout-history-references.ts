import { join } from 'node:path'
import { forEachSessionFile } from '../../../ai-vault/discovery/session-scanner-discovery'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { extractString } from '../../../../shared/text/trimmed-string'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import { readCodexRolloutBytes } from '../../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../../native-chat/transcript-streaming/transcript-stream-lines'

export type ScanCodexRolloutHistoryReferences = (
  homes: readonly string[]
) => Promise<CodexRolloutHistoryReferences>

const SESSION_META_MAX_BYTES = 16 * 1024 * 1024

/**
 * Which rollouts other rollouts read their history prefix from (`session_meta.history_base`).
 * A forked chat stores only its own turns and reads the rest from its parent's file.
 */
export type CodexRolloutHistoryReferences = {
  isReferenced(rolloutId: string): boolean
  forget(rolloutId: string): void
}

/** The rollout id this header reads from; undefined when the header can't be read whole yet. */
async function readHistoryBaseRolloutId(path: string): Promise<string | null | undefined> {
  try {
    for await (const { line, terminated } of splitTranscriptStreamLines(
      readCodexRolloutBytes(path),
      SESSION_META_MAX_BYTES
    )) {
      if (!line.trim()) {
        continue
      }
      if (!terminated) {
        return undefined
      }
      // Most headers name no base: skip parsing their base instructions.
      if (!line.includes('"history_base"')) {
        return null
      }
      const record = parseJsonObject(line)
      const base = asRecord(asRecord(record?.payload)?.history_base)
      return record?.type === 'session_meta'
        ? (extractString(base?.thread_id)?.toLowerCase() ?? null)
        : null
    }
  } catch {
    // Unreadable rollouts reference nothing we can follow, as in Codex's index, until read whole.
  }
  return undefined
}

// A rollout id names one file whose header Codex writes once, so its base never changes.
let basesByRolloutId = new Map<string, string | null>()

/** Mirrors Codex's own delete, which refuses a rollout that another rollout's history still reads. */
export async function scanCodexRolloutHistoryReferences(
  homes: readonly string[]
): Promise<CodexRolloutHistoryReferences> {
  const seen = new Map<string, string | null>()
  const childrenByBase = new Map<string, Set<string>>()
  const baseByChild = new Map<string, string>()
  for (const home of homes) {
    for (const folder of ['sessions', 'archived_sessions']) {
      await forEachSessionFile(
        join(home, folder),
        'codex',
        [],
        { extensions: new Set(['.jsonl', '.zst']), strictErrors: true },
        async (path) => {
          const rolloutId = codexPhysicalRolloutId(path)
          // History passes link one rollout into many homes and Codex compresses it in place.
          if (!rolloutId || seen.has(rolloutId)) {
            return
          }
          const baseId = basesByRolloutId.has(rolloutId)
            ? basesByRolloutId.get(rolloutId)
            : await readHistoryBaseRolloutId(path)
          if (baseId === undefined) {
            return
          }
          seen.set(rolloutId, baseId)
          if (baseId === null || baseId === rolloutId) {
            return
          }
          baseByChild.set(rolloutId, baseId)
          const children = childrenByBase.get(baseId) ?? new Set<string>()
          children.add(rolloutId)
          childrenByBase.set(baseId, children)
        }
      )
    }
  }
  // Rollouts gone from every home drop out.
  basesByRolloutId = seen
  return {
    isReferenced: (rolloutId) => (childrenByBase.get(rolloutId)?.size ?? 0) > 0,
    forget: (rolloutId) => {
      const baseId = baseByChild.get(rolloutId)
      if (baseId) {
        childrenByBase.get(baseId)?.delete(rolloutId)
      }
    }
  }
}

/** One scan shared by every delete batch of a sweep; it runs only once a rollout is ready to go. */
export function createCodexRolloutHistoryReferenceScan(): ScanCodexRolloutHistoryReferences {
  let scan: Promise<CodexRolloutHistoryReferences> | undefined
  return (homes) => (scan ??= scanCodexRolloutHistoryReferences(homes))
}
