import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGitMetadataPath } from '../../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../../shared/gitdir-marker-payload'
import {
  readGitConfigFileEntries,
  readGitConfigFlag,
  readGitConfigValue
} from '../git-config-file-entries'
import { getErrorCode } from '../worktree-operation-options'

/** What the repo config decides about deriving worktree rows from files. */
export type RepoConfigFacts = {
  objectIdLength: 40 | 64
  /** Only changes the sort comparison, never an emitted spelling. */
  ignoreCase: boolean
  sparseCheckout: boolean | undefined
  worktreeConfig: boolean
  /** Why Git must derive this repo's rows, or null when the file rules apply. */
  gitOnlyReason: string | null
}

function isAbsentError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsentError(error)) {
      return null
    }
    throw error
  }
}

/**
 * The repo's Git common dir from its files: `<repo>/.git` as a dir, a `.git` gitfile (separate git
 * dir, submodule, linked worktree) followed through `commondir`, or a bare repo at the path itself.
 * Null when none of those layouts applies; the caller then leaves the repo to Git. Rejects on a read
 * failure other than absence.
 */
export async function resolveRepoCommonDirFromFiles(
  repoPath: string,
  wslDistro?: string
): Promise<string | null> {
  const dotGit = join(repoPath, '.git')
  let gitDir: string
  try {
    const dotGitStats = await stat(dotGit)
    if (dotGitStats.isDirectory()) {
      gitDir = dotGit
    } else {
      const pointer = parseGitdirMarkerPayload(await readFile(dotGit, 'utf8'))
      const resolved = pointer ? resolveGitMetadataPath(repoPath, pointer, { wslDistro }) : null
      if (!resolved) {
        return null
      }
      gitDir = resolved
    }
  } catch (error) {
    if (!isAbsentError(error)) {
      throw error
    }
    // A bare repo keeps HEAD and its object store at the path itself.
    const [head, objects] = await Promise.all([
      stat(join(repoPath, 'HEAD')).catch(() => null),
      stat(join(repoPath, 'objects')).catch(() => null)
    ])
    if (!head?.isFile() || !objects?.isDirectory()) {
      return null
    }
    gitDir = repoPath
  }
  const commonDirPointer = await readOptionalFile(join(gitDir, 'commondir'))
  const commonDir = commonDirPointer
    ? resolveGitMetadataPath(gitDir, commonDirPointer, { wslDistro })
    : null
  return commonDir ?? gitDir
}

const SHA1_LENGTH = 40
const SHA256_LENGTH = 64

/** Reads `<commonDir>/config`. A missing config is Git's defaults; any other failure rejects. */
export async function readRepoConfigFacts(commonDir: string): Promise<RepoConfigFacts> {
  const content = (await readOptionalFile(join(commonDir, 'config'))) ?? ''
  return parseRepoConfigFacts(content)
}

export function parseRepoConfigFacts(content: string): RepoConfigFacts {
  const entries = readGitConfigFileEntries(content)
  const objectFormat = readGitConfigValue(entries, 'extensions', 'objectformat')
    ?.trim()
    .toLowerCase()
  const refStorage = readGitConfigValue(entries, 'extensions', 'refstorage')?.trim().toLowerCase()
  const gitOnlyReason =
    // Loose refs do not exist under reftable; a file read would misreport every branch.
    refStorage && refStorage !== 'files'
      ? `ref storage ${refStorage}`
      : readGitConfigValue(entries, 'core', 'worktree') !== null
        ? 'core.worktree'
        : // Included files can set any of the keys above; only Git resolves them.
          entries.some((entry) => entry.section === 'include' || entry.section === 'includeif')
          ? 'config include'
          : objectFormat && objectFormat !== 'sha1' && objectFormat !== 'sha256'
            ? `object format ${objectFormat}`
            : null
  return {
    objectIdLength: objectFormat === 'sha256' ? SHA256_LENGTH : SHA1_LENGTH,
    ignoreCase: readGitConfigFlag(entries, 'core', 'ignorecase') === true,
    sparseCheckout: readGitConfigFlag(entries, 'core', 'sparsecheckout'),
    worktreeConfig: readGitConfigFlag(entries, 'extensions', 'worktreeconfig') === true,
    gitOnlyReason
  }
}
