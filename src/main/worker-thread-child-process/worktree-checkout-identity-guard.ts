import { WORKTREE_METADATA_READ_FLAGS } from '../workspaces/removal/worktree-checkout-identity'
import { gitRepositoryPathKey } from '../../shared/git/metadata/git-repository-path-key'
import { resolveGitMetadataPath } from '../../shared/git/metadata/git-metadata-path'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileStatSignature } from '../filesystem/file-stat-signature'
import {
  WORKTREE_CHECKOUT_NONCE,
  WORKTREE_IDENTITY_FILE_LIMIT,
  WorktreeRemovalIncarnationChangedError,
  checkoutDirectoryKey,
  checkoutGitDirectory,
  assertCheckoutMetadata,
  assertCheckoutIdentityMatches,
  rethrowCheckoutIdentityError,
  type WorktreeCheckoutSpawnGuard,
  type WorktreeCheckoutIdentity
} from '../../shared/worktree/removal/worktree-checkout-identity'

function readMetadata(path: string) {
  const fd = openSync(path, WORKTREE_METADATA_READ_FLAGS)
  try {
    const stats = fstatSync(fd, { bigint: true })
    if (!stats.isFile() || stats.size > BigInt(WORKTREE_IDENTITY_FILE_LIMIT)) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    const buffer = Buffer.alloc(Number(stats.size) + 1)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes !== Number(stats.size)) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    return { text: buffer.toString('utf8', 0, bytes), key: fileStatSignature(stats) }
  } finally {
    closeSync(fd)
  }
}

/** Worker-only: no asynchronous turn between this check and the native spawn call. */
export function assertWorktreeCheckoutIdentityBeforeSpawn(guard: WorktreeCheckoutSpawnGuard): void {
  const expected = guard.identity
  try {
    if (guard.checkoutRemoved) {
      assertCheckoutRegistrationOnly(expected)
      return
    }
    const rootKey = checkoutDirectoryKey(lstatSync(expected.root, { bigint: true }))
    const marker = readMetadata(join(expected.root, '.git'))
    const gitDir = realpathSync(checkoutGitDirectory(expected.root, marker.text))
    const adminKey = checkoutDirectoryKey(lstatSync(gitDir, { bigint: true }))
    const nonce = readMetadata(join(gitDir, WORKTREE_CHECKOUT_NONCE)).text.trim()
    assertCheckoutMetadata(gitDir, nonce)
    const backlink = readMetadata(join(gitDir, 'gitdir')).text.trim()
    if (realpathSync(resolve(gitDir, backlink)) !== realpathSync(join(expected.root, '.git'))) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    assertCheckoutIdentityMatches(expected, {
      instanceId: expected.instanceId,
      root: expected.root,
      rootKey,
      markerKey: marker.key,
      gitDir,
      adminKey,
      nonce
    })
  } catch (error) {
    rethrowCheckoutIdentityError(error)
  }
}

function assertCheckoutRegistrationOnly(expected: WorktreeCheckoutIdentity): void {
  try {
    lstatSync(expected.root)
    throw new WorktreeRemovalIncarnationChangedError()
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }
  const gitDir = realpathSync(expected.gitDir)
  const nonce = readMetadata(join(gitDir, WORKTREE_CHECKOUT_NONCE)).text.trim()
  assertCheckoutMetadata(gitDir, nonce)
  const backlink = resolveGitMetadataPath(gitDir, readMetadata(join(gitDir, 'gitdir')).text)
  if (
    gitDir !== expected.gitDir ||
    checkoutDirectoryKey(lstatSync(gitDir, { bigint: true })) !== expected.adminKey ||
    nonce !== expected.nonce ||
    !backlink ||
    gitRepositoryPathKey(backlink) !== gitRepositoryPathKey(join(expected.root, '.git'))
  ) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
}
