import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import { getSshFilesystemProvider } from './ssh-filesystem-dispatch'
import { getSshGitProvider } from './ssh-git-dispatch'

/**
 * The one definition of "this relay has registered its providers", shared by the connect
 * wait and the attached check so the two cannot drift apart.
 *
 * A relay serves PTY, git, and filesystem from one session, so a partial set is a
 * half-attached relay rather than a ready one. Classifying it as attached is what strands
 * it: the owner skips the re-attach, nothing else redials, and every operation needing the
 * absent provider keeps failing. Requiring all three also matches what a successful connect
 * already guarantees, which is why the same predicate can serve both callers.
 */
export function areSshRelayProvidersRegistered(connectionId: string): boolean {
  return Boolean(
    getSshPtyProvider(connectionId) &&
    getSshGitProvider(connectionId) &&
    getSshFilesystemProvider(connectionId)
  )
}
