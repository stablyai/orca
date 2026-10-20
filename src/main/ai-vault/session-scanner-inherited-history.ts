import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { resolveCodexRolloutLineage } from '../codex/codex-rollout-lineage'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { SESSION_PREVIEW_MESSAGE_LIMIT } from './session-scanner-accumulator'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'

// Why: a row whose inherited history could not be read must be re-read once
// the ancestor arrives (e.g. bridged later), so the parse cache must not keep it.
const rowsMissingInheritedHistory = new WeakSet<AiVaultSession>()

export function markMissingInheritedHistory(session: AiVaultSession): void {
  rowsMissingInheritedHistory.add(session)
}

export function isMissingInheritedHistory(session: AiVaultSession | null): boolean {
  return session !== null && rowsMissingInheritedHistory.has(session)
}

/**
 * One conversation's fold from the prefix it inherits (a reverted or forked
 * segment's ancestors) followed by its own records — the history Codex itself
 * shows when it resumes this segment.
 */
export function prependInheritedHistory(
  inherited: SessionAccumulator,
  own: SessionAccumulator,
  ownTitleIsMetadata: boolean
): SessionAccumulator {
  const previewMessages = [...inherited.previewMessages, ...own.previewMessages]
  const earliest = [inherited.earliestTimestampMs, own.earliestTimestampMs].filter((ms) => ms > 0)
  return {
    ...own,
    title: ownTitleIsMetadata ? own.title : (inherited.title ?? own.title),
    fallbackTitle: inherited.fallbackTitle ?? own.fallbackTitle,
    cwd: own.cwd ?? inherited.cwd,
    branch: own.branch ?? inherited.branch,
    model: own.model ?? inherited.model,
    createdAt: inherited.createdAt ?? own.createdAt,
    updatedAt: own.updatedAt ?? inherited.updatedAt,
    messageCount: inherited.messageCount + own.messageCount,
    totalTokens: inherited.totalTokens + own.totalTokens,
    previewMessages: previewMessages.slice(-SESSION_PREVIEW_MESSAGE_LIMIT),
    previewMessagesTruncated:
      inherited.previewMessagesTruncated ||
      own.previewMessagesTruncated ||
      previewMessages.length > SESSION_PREVIEW_MESSAGE_LIMIT,
    firstUserPrompt: inherited.firstUserPrompt ?? own.firstUserPrompt,
    lastUserPrompt: own.lastUserPrompt ?? inherited.lastUserPrompt,
    earliestTimestampMs: earliest.length > 0 ? Math.min(...earliest) : 0,
    latestTimestampMs: Math.max(inherited.latestTimestampMs, own.latestTimestampMs)
  }
}

type LineFold = { consumeLine: (line: string) => void; result: () => SessionAccumulator }

/**
 * A segment's fold with the prefixes it inherits folded in front, oldest first,
 * the way Codex replays them. `complete` is false when an ancestor was missing.
 */
export async function withInheritedHistory(
  own: SessionAccumulator,
  ownTitleIsMetadata: boolean,
  createFold: (file: FileWithMtime) => LineFold
): Promise<{ accumulator: SessionAccumulator; complete: boolean }> {
  const lineage = await resolveCodexRolloutLineage(own.filePath, 'scan')
  if (lineage.ancestors.length === 0) {
    return { accumulator: own, complete: lineage.complete }
  }
  const fold = createFold({ path: own.filePath, mtimeMs: 0, modifiedAt: own.modifiedAt })
  try {
    for (const segment of lineage.ancestors) {
      if (segment.endByteOffset === 0) {
        continue
      }
      const input = openTranscriptReadStream(
        segment.path,
        // `end` is inclusive; the recorded offset is the first byte not inherited.
        { encoding: 'utf-8', end: segment.endByteOffset - 1 },
        'scan'
      )
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        fold.consumeLine(line)
      }
    }
  } catch {
    return { accumulator: own, complete: false }
  }
  return {
    accumulator: prependInheritedHistory(fold.result(), own, ownTitleIsMetadata),
    complete: lineage.complete
  }
}
