import { lstat, realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { authorizeExternalPath, resolveAuthorizedPath } from './filesystem-auth'

/**
 * Authorize the destination of a symlink that lives inside an already-allowed root, so an
 * explicitly activated link to an external folder can be read.
 *
 * Returns the canonical target path, or null when the path is not a symlink.
 */
export async function authorizeSymlinkTargetPath(
  linkPath: string,
  store: Store
): Promise<string | null> {
  // Why: preserveSymlink canonicalizes the parent but keeps the leaf, so this proves the link
  // itself sits in an allowed root without following it into an unauthorized destination.
  const authorizedLinkPath = await resolveAuthorizedPath(linkPath, store, { preserveSymlink: true })
  if (!(await lstat(authorizedLinkPath)).isSymbolicLink()) {
    return null
  }
  const targetPath = await realpath(authorizedLinkPath)
  authorizeExternalPath(targetPath)
  return targetPath
}
