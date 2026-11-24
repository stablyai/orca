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

const defaultListSessionFiles = (sessionsRoot: string): AsyncIterable<string> =>
  listCodexSessionRolloutFilesIncrementally(sessionsRoot, { batchSize: 64, yieldMs: 0 })

async function homeHoldsThread(
  homePath: string,
  sessionId: string,
  listSessionFiles: (sessionsRoot: string) => AsyncIterable<string>
): Promise<boolean> {
  const sessionsRoot = join(homePath, 'sessions')
  const suffix = `-${sessionId}.jsonl`.toLowerCase()
  try {
    for await (const filePath of listSessionFiles(sessionsRoot)) {
      const name = getRuntimePathBasename(filePath)
        .toLowerCase()
        .replace(/\.zst$/, '')
      if (name.endsWith(suffix) && codexDatedRolloutRelativePath(sessionsRoot, filePath)) {
        return true
      }
    }
  } catch {
    // An unreadable home cannot prove it holds the thread.
  }
  return false
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
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<boolean> {
  const selectedHome = args.getSelectedAccountCodexHome()
  if (args.transcriptPath?.trim() || !selectedHome) {
    return false
  }
  const list = args.listSessionFiles ?? defaultListSessionFiles
  // The selected account's home ranks first for an ID-only lookup.
  if (!(await homeHoldsThread(selectedHome, args.sessionId, list))) {
    return false
  }
  const otherAccountHomes = args.trustedCodexHomes.filter(
    (homePath) =>
      !sameHome(selectedHome, homePath) &&
      !sameHome(args.systemCodexHomePath, homePath) &&
      !sameHome(args.sharedRuntimeCodexHomePath, homePath)
  )
  for (const homePath of otherAccountHomes) {
    if (await homeHoldsThread(homePath, args.sessionId, list)) {
      return true
    }
  }
  return false
}
