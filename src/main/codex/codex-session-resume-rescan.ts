import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { lstat, realpath } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { codexConversationStore } from './codex-conversation-store-path'
import { readCodexSelectedRollout } from './codex-state-db'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import {
  codexDatedRolloutRelativePath,
  listCodexSessionRolloutFilesIncrementally
} from './codex-session-file-listing'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'
import type { findTrustedCodexSessionResume } from './codex-session-resume-home'

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
    if (isDefinitiveAbsence(error)) {
      return false
    }
    if (isSelectedAccount) {
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
    }
    return false
  }
}

export async function rescanTrustedCodexSessionResume(
  args: Parameters<typeof findTrustedCodexSessionResume>[0]
): Promise<{ homePath: string; transcriptPath: string } | null> {
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
            !isDefinitiveAbsence(error)
          ) {
            throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
          }
        }
      ))
  const matches: { homePath: string; transcriptPath: string; selectedRollout: string }[] = []
  const expectedSuffix = `-${args.sessionId}.jsonl`.toLowerCase()
  const seenStores = new Set<string>()
  const walks = new Map<string, { root: string; files: string[] }>()
  for (const homePath of rankTrustedCodexHomesForRescan(args, selectedAccountHome)) {
    const store = codexConversationStore(homePath)
    const comparisonStore = normalizeRuntimePathForComparison(store)
    if (seenStores.has(comparisonStore)) {
      continue
    }
    const sessionsRoot = join(homePath, 'sessions')
    if (
      !args.listSessionFiles &&
      !sessionsTreeIsPresent(sessionsRoot, isSelectedAccountHome(selectedAccountHome, homePath))
    ) {
      continue
    }
    seenStores.add(comparisonStore)
    const physicalRoot = await realpath(sessionsRoot).catch(() => sessionsRoot)
    const physicalKey = normalizeRuntimePathForComparison(physicalRoot)
    let walk = walks.get(physicalKey)
    if (!walk) {
      const files: string[] = []
      for await (const filePath of listSessionFiles(sessionsRoot)) {
        if (
          filePath
            .toLowerCase()
            .replace(/\.zst$/, '')
            .endsWith(expectedSuffix)
        ) {
          files.push(filePath)
        }
      }
      walk = { root: sessionsRoot, files }
      walks.set(physicalKey, walk)
    }
    const candidates: string[] = []
    for (const walkedPath of walk.files) {
      const tail = codexDatedRolloutRelativePath(walk.root, walkedPath)
      if (!tail) {
        continue
      }
      const filePath = walk.root === sessionsRoot ? walkedPath : join(sessionsRoot, tail)
      const plainFilePath = filePath.endsWith('.jsonl.zst')
        ? filePath.slice(0, -'.zst'.length)
        : filePath
      // The entry proves the compressed file exists; only probe its preferred plain sibling.
      const preferredFilePath =
        plainFilePath !== filePath &&
        (args.fileIsRegular
          ? args.fileIsRegular(plainFilePath)
          : await lstat(plainFilePath).then(
              (entry) => entry.isFile(),
              () => false
            ))
          ? plainFilePath
          : filePath
      const plainFileName = getRuntimePathBasename(preferredFilePath)
        .toLowerCase()
        .replace(/\.zst$/, '')
      if (
        codexDatedRolloutRelativePath(sessionsRoot, preferredFilePath) &&
        plainFileName.endsWith(expectedSuffix)
      ) {
        candidates.push(preferredFilePath)
      }
    }
    if (candidates.length === 0) {
      continue
    }
    const selected = readCodexSelectedRollout(store, args.sessionId)
    if (selected) {
      const physicalSelected = await realpath(selected).catch(() => selected)
      const selectedTail =
        codexDatedRolloutRelativePath(join(store, 'sessions'), selected) ??
        codexDatedRolloutRelativePath(physicalRoot, physicalSelected)
      const selectedCandidate = selectedTail ? join(sessionsRoot, selectedTail) : selected
      const transcriptPath = candidates.find(
        (candidate) =>
          normalizeRuntimePathForComparison(candidate).replace(/\.zst$/, '') ===
          normalizeRuntimePathForComparison(selectedCandidate).replace(/\.zst$/, '')
      )
      if (transcriptPath) {
        matches.push({ homePath, transcriptPath, selectedRollout: selected })
      }
      continue
    }
    for (const transcriptPath of candidates) {
      matches.push({ homePath, transcriptPath, selectedRollout: transcriptPath })
    }
  }
  matches.sort((left, right) =>
    getRuntimePathBasename(right.selectedRollout).localeCompare(
      getRuntimePathBasename(left.selectedRollout)
    )
  )
  const best = matches[0]
  return best ? { homePath: best.homePath, transcriptPath: best.transcriptPath } : null
}
