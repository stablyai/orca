import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { findTrustedCodexSessionResume } from './codex-session-resume-home'

function sameHome(left: string | null, right: string): boolean {
  return (
    left !== null &&
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  )
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
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<boolean> {
  const selectedHome = args.getSelectedAccountCodexHome()
  if (args.transcriptPath?.trim() || !selectedHome) {
    return false
  }
  const winner = await findTrustedCodexSessionResume(args)
  if (!winner || !sameHome(selectedHome, winner.homePath)) {
    return false
  }
  const notMigrationHome = (homePath: string): boolean =>
    !sameHome(selectedHome, homePath) &&
    !sameHome(args.systemCodexHomePath, homePath) &&
    !sameHome(args.sharedRuntimeCodexHomePath, homePath)
  const otherAccountHomes = args.trustedCodexHomes.filter(notMigrationHome)
  for (const homePath of otherAccountHomes) {
    const found = await findTrustedCodexSessionResume({
      ...args,
      trustedCodexHomes: [homePath],
      getSelectedAccountCodexHome: () => null
    })
    if (found) {
      return true
    }
  }
  return false
}
