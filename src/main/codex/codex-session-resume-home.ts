import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'

// Why: only Codex's dated rollout layout may establish account-home provenance; nested/misplaced JSONL must not select credentials.
const DATED_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/]+\.jsonl(?:\.zst)?`
const ROLLOUT_RELATIVE_PATH = new RegExp(`^${DATED_ROLLOUT_TAIL}$`)
// Why: case-insensitive because trusted-home matching folds Windows path case too.
const CODEX_ROLLOUT_LAYOUT_PATH = new RegExp(`(?:^|/)sessions/${DATED_ROLLOUT_TAIL}$`, 'i')

/** `resume` pins CODEX_HOME to the account that owns the rollout. `fresh` means
 *  provenance could not be verified, so the caller drops the resume argv — an
 *  unverifiable rollout must never resume under whichever account is selected now.
 *  `claimedCodexProvenance` gates the user-facing notice: a path that claimed real
 *  Codex layout is worth reporting, stale cross-agent metadata is not. */
export type CodexSessionResumePreparation =
  | { outcome: 'resume'; codexHomePath: string }
  | { outcome: 'fresh'; claimedCodexProvenance: boolean }

function isCodexRolloutInsideSessionsRoot(sessionsRoot: string, filePath: string): boolean {
  const relativePath = relativePathInsideRoot(sessionsRoot, filePath)
  return Boolean(relativePath && ROLLOUT_RELATIVE_PATH.test(relativePath.replace(/\\/g, '/')))
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function resolveExistingRolloutPath(
  transcriptPath: string,
  fileIsRegular: (filePath: string) => boolean
): string | null {
  const plainPath = transcriptPath.endsWith('.jsonl.zst')
    ? transcriptPath.slice(0, -'.zst'.length)
    : transcriptPath.endsWith('.jsonl')
      ? transcriptPath
      : null
  if (!plainPath) {
    return fileIsRegular(transcriptPath) ? transcriptPath : null
  }
  if (fileIsRegular(plainPath)) {
    return plainPath
  }
  const compressedPath = `${plainPath}.zst`
  return fileIsRegular(compressedPath) ? compressedPath : null
}

function resolveTrustedCodexSessionResume(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): { homePath: string; transcriptPath: string } | null {
  const persistedPath = args.transcriptPath?.trim()
  if (!persistedPath) {
    return null
  }

  for (const homePath of args.trustedCodexHomes) {
    const sessionsRoot = join(homePath, 'sessions')
    if (!isCodexRolloutInsideSessionsRoot(sessionsRoot, persistedPath)) {
      continue
    }
    const transcriptPath = resolveExistingRolloutPath(
      persistedPath,
      args.fileIsRegular ?? isRegularFile
    )
    if (transcriptPath) {
      return { homePath, transcriptPath }
    }
  }
  return null
}

export function resolveTrustedCodexSessionResumeHome(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): string | null {
  return resolveTrustedCodexSessionResume(args)?.homePath ?? null
}

/**
 * True when transcriptPath claims Codex's dated rollout layout, under any home and without
 * checking existence — separating rejected Codex provenance from cross-agent/stale metadata.
 * Not scoped to trusted homes: a rollout under a removed home is still rejected provenance,
 * and admitting it would resume that session under whichever account is selected now.
 */
export function claimsCodexRolloutLayout(transcriptPath: string | undefined): boolean {
  const persistedPath = transcriptPath?.trim()
  if (!persistedPath) {
    return false
  }
  return CODEX_ROLLOUT_LAYOUT_PATH.test(persistedPath.replace(/\\/g, '/'))
}

/**
 * Verified provenance, or an explicit fall-back to a fresh session. Never rejects:
 * the caller drops the resume argv on `fresh`, so a rollout Orca cannot place under a
 * trusted home resumes nowhere instead of resuming under the selected account (#10793).
 *
 * The rescan ranking inputs are required here for the same reason they are required on
 * findTrustedCodexSessionResume, and are forwarded wholesale so this wrapper cannot drop one.
 */
export async function resolveCodexSessionResumeProvenance(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<
  | { outcome: 'resume'; homePath: string; transcriptPath: string }
  | { outcome: 'fresh'; claimedCodexProvenance: boolean }
> {
  const sessionSource = await findTrustedCodexSessionResume(args)
  return sessionSource
    ? { outcome: 'resume', ...sessionSource }
    : { outcome: 'fresh', claimedCodexProvenance: claimsCodexRolloutLayout(args.transcriptPath) }
}

/**
 * Orders trusted homes for the legacy id rescan, lowest wins.
 *
 * The winning home becomes the resumed pane's CODEX_HOME, so it picks the
 * account. Rank the currently selected account's own home first — once the same
 * rollout sits in several homes the id alone no longer names an account, and
 * resuming under the account the user has selected is what
 * they asked for. The real system home ranks next because codex refreshes it
 * directly. Everything else is ordered by normalized path so no winner ever
 * depends on the order accounts happen to sit in settings.
 *
 * The shared runtime mirror ranks above the remaining homes because winning is
 * not inert for it: with no account selected it is the only home that triggers
 * the legacy migration into the real system home
 * (prepareLegacySharedCodexSessionResume, which also requires the system-default
 * selection), and that migration is how such a resume lands on ~/.codex instead
 * of some account's home. Letting a per-account home outrank it by mere path
 * order would silently route that selection to an account the user did not pick.
 * With an account selected the migration cannot fire either way, so this tier
 * just preserves the pre-ranking order rather than inventing a new winner.
 *
 * All inputs are required, not optional: a caller that forgot one would
 * silently degrade to pure path order, which is the accident this exists to
 * remove. The selection arrives as a thunk because resolving it stats the
 * account's ownership marker, and the far more common provenance-present
 * resume never reaches the ranking at all.
 */
function rankTrustedCodexHomesForRescan(args: {
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
}): string[] {
  const toComparisonHome = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim()
    return trimmed ? normalizeRuntimePathForComparison(trimmed) : null
  }
  const selectedComparison = toComparisonHome(args.getSelectedAccountCodexHome())
  const systemComparison = toComparisonHome(args.systemCodexHomePath)
  const sharedRuntimeComparison = toComparisonHome(args.sharedRuntimeCodexHomePath)
  const rankOf = (comparisonHome: string): number => {
    if (selectedComparison && comparisonHome === selectedComparison) {
      return 0
    }
    if (systemComparison && comparisonHome === systemComparison) {
      return 1
    }
    return sharedRuntimeComparison && comparisonHome === sharedRuntimeComparison ? 2 : 3
  }
  return args.trustedCodexHomes
    .map((homePath) => ({ homePath, comparisonHome: normalizeRuntimePathForComparison(homePath) }))
    .sort((left, right) => {
      const rankDelta = rankOf(left.comparisonHome) - rankOf(right.comparisonHome)
      if (rankDelta !== 0) {
        return rankDelta
      }
      return left.comparisonHome < right.comparisonHome
        ? -1
        : left.comparisonHome > right.comparisonHome
          ? 1
          : 0
    })
    .map((entry) => entry.homePath)
}

export async function findTrustedCodexSessionResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<{ homePath: string; transcriptPath: string } | null> {
  const directSession = resolveTrustedCodexSessionResume(args)
  if (directSession) {
    return directSession
  }
  if (args.transcriptPath?.trim()) {
    // Why: stale/rejected provenance must not select a same-id rollout under different account credentials; scanning is legacy-only.
    return null
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.sessionId)) {
    return null
  }

  const listSessionFiles =
    args.listSessionFiles ??
    ((sessionsRoot: string) =>
      listCodexSessionRolloutFilesIncrementally(sessionsRoot, { batchSize: 64, yieldMs: 0 }))
  const expectedSuffix = `-${args.sessionId}.jsonl`.toLowerCase()
  const seenHomes = new Set<string>()
  for (const homePath of rankTrustedCodexHomesForRescan(args)) {
    const comparisonHome = normalizeRuntimePathForComparison(homePath)
    if (seenHomes.has(comparisonHome)) {
      continue
    }
    seenHomes.add(comparisonHome)
    const sessionsRoot = join(homePath, 'sessions')
    if (!args.listSessionFiles && !existsSync(sessionsRoot)) {
      continue
    }
    for await (const filePath of listSessionFiles(sessionsRoot)) {
      const plainFilePath = filePath.endsWith('.jsonl.zst')
        ? filePath.slice(0, -'.zst'.length)
        : filePath
      // Why: the directory entry already proves the compressed file exists; only probe its preferred plain sibling.
      const preferredFilePath =
        plainFilePath !== filePath && (args.fileIsRegular ?? isRegularFile)(plainFilePath)
          ? plainFilePath
          : filePath
      const plainFileName = getRuntimePathBasename(preferredFilePath)
        .toLowerCase()
        .replace(/\.zst$/, '')
      if (
        isCodexRolloutInsideSessionsRoot(sessionsRoot, preferredFilePath) &&
        plainFileName.endsWith(expectedSuffix)
      ) {
        return { homePath, transcriptPath: preferredFilePath }
      }
    }
  }
  return null
}
