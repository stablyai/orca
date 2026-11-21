import { constants } from 'node:fs'
import { resolveGitCommonDirectory } from '../../../shared/git/metadata/git-common-directory'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileStatSignature } from '../../filesystem/file-stat-signature'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import {
  WORKTREE_CHECKOUT_NONCE,
  WORKTREE_IDENTITY_FILE_LIMIT,
  WorktreeRemovalIncarnationChangedError,
  WorktreeRemovalIdentityUnverifiableError,
  checkoutDirectoryKey,
  checkoutGitDirectory,
  assertCheckoutMetadata,
  assertCheckoutIdentityMatches,
  rethrowCheckoutIdentityError,
  type WorktreeCheckoutIdentity
} from '../../../shared/worktree/removal/worktree-checkout-identity'

export const WORKTREE_METADATA_READ_FLAGS =
  constants.O_RDONLY |
  (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)

async function readMetadata(path: string) {
  const file = await open(path, WORKTREE_METADATA_READ_FLAGS)
  try {
    const stats = await file.stat({ bigint: true })
    if (!stats.isFile() || stats.size > BigInt(WORKTREE_IDENTITY_FILE_LIMIT)) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    const buffer = Buffer.alloc(Number(stats.size) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== Number(stats.size)) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    return { text: buffer.toString('utf8', 0, bytesRead), key: fileStatSignature(stats) }
  } finally {
    await file.close()
  }
}

async function readIdentity(root: string, instanceId: string, repoPath?: string) {
  const rootKey = checkoutDirectoryKey(await lstat(root, { bigint: true }))
  const marker = await readMetadata(join(root, '.git'))
  const gitDir = await realpath(checkoutGitDirectory(root, marker.text))
  const adminKey = checkoutDirectoryKey(await lstat(gitDir, { bigint: true }))
  const noncePath = join(gitDir, WORKTREE_CHECKOUT_NONCE)
  const backlink = (await readMetadata(join(gitDir, 'gitdir'))).text.trim()
  if ((await realpath(resolve(gitDir, backlink))) !== (await realpath(join(root, '.git')))) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
  if (repoPath) {
    const commonDir = await resolveGitCommonDirectory(repoPath)
    if (!commonDir || dirname(gitDir) !== (await realpath(join(commonDir, 'worktrees')))) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    try {
      const file = await open(noncePath, 'wx', 0o600)
      try {
        await file.writeFile(`${randomUUID()}\n`)
      } finally {
        await file.close()
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
    }
  }
  const nonce = (await readMetadata(noncePath)).text.trim()
  assertCheckoutMetadata(gitDir, nonce)
  return {
    instanceId,
    root: resolve(root),
    rootKey,
    markerKey: marker.key,
    gitDir,
    adminKey,
    nonce
  }
}

/** One small admin marker per physical checkout, created only for an actual cleanup recheck. */
export async function captureWorktreeCheckoutIdentity(
  root: string,
  instanceId: string,
  repoPath: string
) {
  try {
    return Object.freeze(await readIdentity(root, instanceId, repoPath))
  } catch {
    // Windows can't read a WSL checkout's identity reliably, so a WSL workspace is kept, not judged changed.
    throw isWslUncPath(root)
      ? new WorktreeRemovalIdentityUnverifiableError()
      : new WorktreeRemovalIncarnationChangedError()
  }
}

export async function assertWorktreeCheckoutIdentity(
  expected: WorktreeCheckoutIdentity,
  markerGone = false
): Promise<void> {
  try {
    if (markerGone) {
      if (checkoutDirectoryKey(await lstat(expected.root, { bigint: true })) !== expected.rootKey) {
        throw new WorktreeRemovalIncarnationChangedError()
      }
      try {
        await lstat(join(expected.root, '.git'))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          if (
            checkoutDirectoryKey(await lstat(expected.gitDir, { bigint: true })) !==
              expected.adminKey ||
            (await readMetadata(join(expected.gitDir, WORKTREE_CHECKOUT_NONCE))).text.trim() !==
              expected.nonce
          ) {
            throw new WorktreeRemovalIncarnationChangedError()
          }
          return
        }
        throw error
      }
    }
    assertCheckoutIdentityMatches(expected, await readIdentity(expected.root, expected.instanceId))
  } catch (error) {
    rethrowCheckoutIdentityError(error)
  }
}
