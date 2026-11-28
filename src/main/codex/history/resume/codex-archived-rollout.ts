import { dirname, join } from 'node:path'
import { relativePathInsideRoot } from '../../../../shared/file-access/cross-platform-path'

/**
 * Codex archives a rollout idle 7+ days as a flat `.jsonl.zst` in `archived_sessions`, a sibling of
 * the `sessions` tree rather than a folder inside it. An archived rollout is the same conversation,
 * so it carries the same credential provenance and resumes from the same dated tail.
 */
const ARCHIVED_ROLLOUT_NAME = /^rollout-[^/:]+\.jsonl(?:\.zst)?$/

/** The `YYYY/MM/DD/rollout-*.jsonl` a rollout's file name states it started on. */
const ROLLOUT_START_STAMP = /^rollout-(\d{4})-(\d{2})-(\d{2})T/

function trustedComparisonCopy(filePath: string): string | null {
  if (filePath.startsWith('\\\\.\\')) {
    return null
  }
  if (!filePath.startsWith('\\\\?\\')) {
    return filePath
  }
  return filePath.match(/^\\\\\?\\([A-Za-z]:[\\/][\s\S]*)$/)?.[1] ?? null
}

/** Callers pass the `sessions` root; its archive sits beside it, never beneath it. */
function archivedRolloutName(sessionsRoot: string, filePath: string): string | null {
  const archiveRoot = trustedComparisonCopy(
    join(dirname(trustedComparisonCopy(sessionsRoot) ?? sessionsRoot), 'archived_sessions')
  )
  const candidate = trustedComparisonCopy(filePath)
  if (!archiveRoot || !candidate) {
    return null
  }
  // Windows-syntax suffixes come back with `/` separators; POSIX keeps `\` as a name byte.
  const name = relativePathInsideRoot(archiveRoot, candidate)
  return name && ARCHIVED_ROLLOUT_NAME.test(name) ? name : null
}

/** Whether the path is a rollout this home owns through its flat archive. */
export function isArchivedCodexRolloutPath(sessionsRoot: string, filePath: string): boolean {
  return archivedRolloutName(sessionsRoot, filePath) !== null
}

/** Recognize a Codex archive path by shape alone, for provenance recorded under a lost home. */
export function claimsArchivedCodexRolloutLayout(transcriptPath: string): boolean {
  return /(?:^|\/)archived_sessions\/rollout-[^/]+\.jsonl(?:\.zst)?$/i.test(transcriptPath)
}

/**
 * The `YYYY/MM/DD/` tail a resume of an archived rollout targets. It keeps `.zst`: a resume
 * hard-links the file, so a compressed source must never be named as plain JSON, and Codex already
 * stores `.jsonl.zst` in the dated tree.
 */
export function archivedCodexRolloutResumeTail(
  sessionsRoot: string,
  filePath: string
): string | null {
  const name = archivedRolloutName(sessionsRoot, filePath)
  const stamp = name ? ROLLOUT_START_STAMP.exec(name) : null
  return stamp ? `${stamp[1]}/${stamp[2]}/${stamp[3]}/${name}` : null
}
