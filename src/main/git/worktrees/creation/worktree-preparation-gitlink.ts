import { lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { readGitAdminFile } from '../../../../shared/git/metadata/git-common-directory'
import { GUEST_ROOTED_PATH } from '../../../../shared/git/metadata/git-metadata-path'
import { stripWin32LongPathPrefix } from '../../../../shared/file-access/windows-path-access'
import { toLinuxPath } from '../../../../shared/file-access/wsl-paths'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'

/** Git refuses to remove a checkout without its gitlink; restore one naming its verified admin dir. */
export async function restoreMissingGitlink(
  checkoutPath: string,
  gitDir: string,
  signal: AbortSignal
): Promise<void> {
  const checkout = toHostFilesystemPath(checkoutPath)
  // Git's removal follows a symlinked checkout path and would empty its target.
  if (!(await waitForPromiseWithSignal(lstat(checkout), signal)).isDirectory()) {
    throw new Error('The prepared checkout is not a directory.')
  }
  const backlink = await readGitAdminFile(toHostFilesystemPath(join(gitDir, 'gitdir')), signal)
  const adminDir = stripWin32LongPathPrefix(gitDir)
  // Match the Git that created the worktree: only WSL Git writes a guest-rooted /x backlink.
  const pointer =
    process.platform === 'win32' && GUEST_ROOTED_PATH.test(backlink ?? '')
      ? toLinuxPath(adminDir)
      : adminDir
  await waitForPromiseWithSignal(
    writeFile(join(checkout, '.git'), `gitdir: ${pointer}\n`, { flag: 'wx' }),
    signal
  )
}
