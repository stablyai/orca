import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

// Only the dated rollout layout may establish credential provenance.
const CLAIMED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/]+\.jsonl(?:\.zst)?`
const TRUSTED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/:]+\.jsonl(?:\.zst)?`
const ROLLOUT_RELATIVE_PATH = new RegExp(`^${TRUSTED_CODEX_ROLLOUT_TAIL}$`)
// Match the case folding used for trusted Windows homes.
const CODEX_ROLLOUT_LAYOUT_PATH = new RegExp(`(?:^|/)sessions/${CLAIMED_CODEX_ROLLOUT_TAIL}$`, 'i')

/** Unverified provenance starts fresh; claimed Codex layout controls the rejection notice. */
export type CodexSessionResumePreparation =
  | { outcome: 'resume'; codexHomePath: string; reconcileSharedRuntimeAuth?: boolean }
  | { outcome: 'fresh'; claimedCodexProvenance: boolean }

// Only fold extended drive paths; reject device namespaces and extended UNC paths.
function toCodexTrustedPathComparisonCopy(filePath: string): string | null {
  if (filePath.startsWith('\\\\.\\')) {
    return null
  }
  if (!filePath.startsWith('\\\\?\\')) {
    return filePath
  }
  return filePath.match(/^\\\\\?\\([A-Za-z]:[\\/][\s\S]*)$/)?.[1] ?? null
}

function isCodexRolloutInsideSessionsRoot(sessionsRoot: string, filePath: string): boolean {
  const comparisonSessionsRoot = toCodexTrustedPathComparisonCopy(sessionsRoot)
  const comparisonFilePath = toCodexTrustedPathComparisonCopy(filePath)
  if (!comparisonSessionsRoot || !comparisonFilePath) {
    return false
  }
  const relativePath = relativePathInsideRoot(comparisonSessionsRoot, comparisonFilePath)
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

export function trustedCodexResumeHomes(
  runtimeHome: { getHostCodexHomePathsForSessionDiscovery(): string[] },
  systemHomePath: string
): string[] {
  // Import-only history sources cannot become CODEX_HOME or bypass account auth.
  return [systemHomePath, ...runtimeHome.getHostCodexHomePathsForSessionDiscovery()]
}

export function resolveTrustedCodexSessionResumeHome(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): string | null {
  return resolveTrustedCodexSessionResume(args)?.homePath ?? null
}

/** Recognize rejected Codex provenance even under a removed or untrusted home. */
export function claimsCodexRolloutLayout(transcriptPath: string | undefined): boolean {
  const persistedPath = transcriptPath?.trim()
  if (!persistedPath) {
    return false
  }
  return CODEX_ROLLOUT_LAYOUT_PATH.test(persistedPath.replace(/\\/g, '/'))
}

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

// The winning home selects credentials; never let settings order choose the account.
function rankTrustedCodexHomesForRescan(
  args: {
    trustedCodexHomes: readonly string[]
    getSelectedAccountCodexHome: () => string | null
    systemCodexHomePath: string | null
    sharedRuntimeCodexHomePath: string | null
  },
  selectedAccountHome = args.getSelectedAccountCodexHome()
): string[] {
  const toComparisonHome = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim()
    return trimmed ? normalizeRuntimePathForComparison(trimmed) : null
  }
  const selectedComparison = toComparisonHome(selectedAccountHome)
  const systemComparison = toComparisonHome(args.systemCodexHomePath)
  const sharedRuntimeComparison = toComparisonHome(args.sharedRuntimeCodexHomePath)
  const rankOf = (comparisonHome: string): number => {
    if (selectedComparison && comparisonHome === selectedComparison) {
      return 0
    }
    // Codex refreshes the system home directly, so prefer it after the selected account.
    if (systemComparison && comparisonHome === systemComparison) {
      return 1
    }
    // Prefer the shared mirror so system-default resumes can migrate into the system home.
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

function isSelectedAccountHome(selectedAccountHome: string | null, homePath: string): boolean {
  return (
    selectedAccountHome !== null &&
    normalizeRuntimePathForComparison(selectedAccountHome) ===
      normalizeRuntimePathForComparison(homePath)
  )
}

// Only definitive absence may skip the selected account; transient errors risk wrong credentials.
function sessionsTreeIsPresent(sessionsRoot: string, isSelectedAccount: boolean): boolean {
  try {
    statSync(sessionsRoot)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    if (isSelectedAccount) {
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
    }
    return false
  }
}

function isDefinitiveSessionTreeAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
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
    // Rejected provenance must not fall back to a same-ID rollout under another account.
    return null
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.sessionId)) {
    return null
  }

  const selectedAccountHome = args.getSelectedAccountCodexHome()
  const selectedSessionsRoot = selectedAccountHome
    ? normalizeRuntimePathForComparison(join(selectedAccountHome, 'sessions'))
    : null
  const listSessionFiles =
    args.listSessionFiles ??
    ((sessionsRoot: string) =>
      listCodexSessionRolloutFilesIncrementally(
        sessionsRoot,
        { batchSize: 64, yieldMs: 0 },
        (_directoryPath, error) => {
          if (
            selectedSessionsRoot === normalizeRuntimePathForComparison(sessionsRoot) &&
            !isDefinitiveSessionTreeAbsence(error)
          ) {
            throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
          }
        }
      ))
  const expectedSuffix = `-${args.sessionId}.jsonl`.toLowerCase()
  const seenHomes = new Set<string>()
  for (const homePath of rankTrustedCodexHomesForRescan(args, selectedAccountHome)) {
    const comparisonHome = normalizeRuntimePathForComparison(homePath)
    if (seenHomes.has(comparisonHome)) {
      continue
    }
    seenHomes.add(comparisonHome)
    const sessionsRoot = join(homePath, 'sessions')
    if (
      !args.listSessionFiles &&
      !sessionsTreeIsPresent(sessionsRoot, isSelectedAccountHome(selectedAccountHome, homePath))
    ) {
      continue
    }
    for await (const filePath of listSessionFiles(sessionsRoot)) {
      const plainFilePath = filePath.endsWith('.jsonl.zst')
        ? filePath.slice(0, -'.zst'.length)
        : filePath
      // The entry proves the compressed file exists; only probe its preferred plain sibling.
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
