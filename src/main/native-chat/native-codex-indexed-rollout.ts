import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readIndexedCodexThreadRolloutPath } from '../codex/history/index/codex-state-db'
import { readCodexRolloutSessionMetaId } from '../codex/history/rollouts/codex-rollout-session-meta'
import { needsWslHostResolution } from './host-readable-transcript-path'
import { admitTranscriptPath } from './transcript-path-admission'

/** Validate and return the actual filesystem target selected by this native account's index. */
export async function findIndexedNativeCodexRollout(
  root: string,
  sessionId: string,
  signal?: AbortSignal,
  strictErrors?: boolean
): Promise<string | null> {
  signal?.throwIfAborted()
  const indexed = readIndexedCodexThreadRolloutPath(dirname(root), sessionId, strictErrors)
  if (!indexed) {
    return null
  }
  let target: string | null = null
  if (
    isAbsolute(root) &&
    isAbsolute(indexed) &&
    !isWslUncPath(indexed) &&
    !needsWslHostResolution(indexed)
  ) {
    try {
      // Resolve before lexical normalization: symlink/.. can name a different filesystem target.
      const [canonicalRoot, actualTarget] = await Promise.all([realpath(root), realpath(indexed)])
      target = (await admitTranscriptPath(canonicalRoot, actualTarget))?.path ?? null
    } catch (error) {
      signal?.throwIfAborted()
      if (strictErrors) {
        throw error
      }
    }
  }
  signal?.throwIfAborted()
  if (target && (await readCodexRolloutSessionMetaId(target, signal)) === sessionId) {
    return target
  }
  if (strictErrors) {
    throw new Error('The indexed Codex rollout does not match this account and session.')
  }
  return null
}
