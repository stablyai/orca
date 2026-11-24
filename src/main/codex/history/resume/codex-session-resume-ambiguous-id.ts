import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison
} from '../../../../shared/file-access/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from '../rollouts/codex-session-file-listing'
import { codexDatedRolloutRelativePath } from './codex-session-resume-home'

function sameHome(left: string | null, right: string): boolean {
  return (
    left !== null &&
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  )
}

type ListSessionFiles = (
  sessionsRoot: string,
  onDirectoryError: (error: unknown) => void
) => AsyncIterable<string>

const defaultListSessionFiles: ListSessionFiles = (sessionsRoot, onDirectoryError) =>
  listCodexSessionRolloutFilesIncrementally(
    sessionsRoot,
    { batchSize: 64, yieldMs: 0 },
    (_dir, error) => onDirectoryError(error)
  )

function isDefinitiveAbsence(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `unknown`: part of the tree could not be read, so absence is not proven. */
async function homeHoldsThread(
  homePath: string,
  sessionId: string,
  listSessionFiles: ListSessionFiles
): Promise<boolean | 'unknown'> {
  const sessionsRoot = join(homePath, 'sessions')
  const suffix = `-${sessionId}.jsonl`.toLowerCase()
  let incomplete = false
  const noteError = (error: unknown): void => {
    incomplete ||= !isDefinitiveAbsence(error)
  }
  try {
    for await (const filePath of listSessionFiles(sessionsRoot, noteError)) {
      const name = getRuntimePathBasename(filePath)
        .toLowerCase()
        .replace(/\.zst$/, '')
      if (name.endsWith(suffix) && codexDatedRolloutRelativePath(sessionsRoot, filePath)) {
        return true
      }
    }
  } catch (error) {
    noteError(error)
  }
  return incomplete ? 'unknown' : false
}

// Managed homes may share one history through a linked sessions folder; that is one copy, not two.
async function sessionsStoreIdentity(homePath: string): Promise<string> {
  const sessionsRoot = join(homePath, 'sessions')
  try {
    return normalizeRuntimePathForComparison(await realpath(sessionsRoot))
  } catch {
    return normalizeRuntimePathForComparison(sessionsRoot)
  }
}

/**
 * An ID-only resume is ambiguous when the selected account's copy of the thread would win while
 * another managed account's home holds the same thread: only the transcript path names the account
 * it belongs to. Copies in the system or shared legacy home are migrations and stay resumable.
 */
export async function isAmbiguousIdOnlyAccountResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  listSessionFiles?: ListSessionFiles
}): Promise<boolean> {
  const selectedHome = args.getSelectedAccountCodexHome()
  if (args.transcriptPath?.trim() || !selectedHome) {
    return false
  }
  const list: ListSessionFiles = args.listSessionFiles ?? defaultListSessionFiles
  // The selected account's home ranks first for an ID-only lookup.
  if ((await homeHoldsThread(selectedHome, args.sessionId, list)) !== true) {
    return false
  }
  const selectedStore = await sessionsStoreIdentity(selectedHome)
  const otherAccountHomes = args.trustedCodexHomes.filter(
    (homePath) =>
      !sameHome(selectedHome, homePath) &&
      !sameHome(args.systemCodexHomePath, homePath) &&
      !sameHome(args.sharedRuntimeCodexHomePath, homePath)
  )
  for (const homePath of otherAccountHomes) {
    if ((await sessionsStoreIdentity(homePath)) === selectedStore) {
      continue
    }
    // A copy elsewhere, or a home that could not be fully read, leaves the account unproven.
    if ((await homeHoldsThread(homePath, args.sessionId, list)) !== false) {
      return true
    }
  }
  return false
}
