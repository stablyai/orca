/** What an unreadable WSL move journal still fences: folders its moves could have taken. */
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { wslMappedDriveLastKnownShare } from '../../../wsl/filesystem/wsl-mapped-drive-last-known'
import { classifyWslMappedDrive } from '../../../wsl/filesystem/wsl-mapped-drive-share'

// Each unknown letter is classified once, so a local disk's projects unblock when it answers.
const classifying = new Set<string>()

/**
 * Without the journal, any folder a move could have taken: a UNC path, or a drive letter not
 * known (from this launch or a saved answer) to point outside WSL. A moved `W:\` row has nothing
 * else marking it as moved. Only for an unreadable journal, an unknown letter gets one bounded
 * lookup; a letter last known in WSL is never read, so no distro boots for it.
 */
export function mayBeInWsl(path: string): boolean {
  if (isWslUncPath(path)) {
    return true
  }
  const letter = /^([A-Za-z]):[\\/]/.exec(path)?.[1]?.toUpperCase()
  // Off Windows a drive letter names no share, so it's never in WSL.
  if (!letter || process.platform !== 'win32') {
    return false
  }
  const known = wslMappedDriveLastKnownShare(letter)
  if (!known && !classifying.has(letter)) {
    classifying.add(letter)
    // One that didn't settle may be asked again; a hung drive's lookup is shared, not repeated.
    void classifyWslMappedDrive(letter)
      .catch(() => null)
      .then((answer) => answer ?? classifying.delete(letter))
  }
  return !known || (known.share !== null && isWslUncPath(known.share))
}

export function resetUnreadJournalClassificationForTests(): void {
  classifying.clear()
}
