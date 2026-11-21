import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isSamePath, readOptional } from './git-dir-branch-state'
import { checkedIo } from './file-check-deadline'

// Git caps a gitfile at 1 MiB.
const MAX_GITFILE_BYTES = 1 << 20

/** The git dir a `.git` gitfile points to, parsed as Git does (`gitdir: <path>`, trailing line ends dropped). */
async function readGitfileTarget(
  dotGit: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  const text = await readOptional(dotGit, MAX_GITFILE_BYTES)
  let end = text.length
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) {
    end -= 1
  }
  const pointer = text.startsWith('gitdir: ') ? text.slice('gitdir: '.length, end) : ''
  if (!pointer) {
    return undefined
  }
  return isAbsolute(pointer) ? toHostPath(pointer) : join(dirname(dotGit), pointer)
}

/** A linked git dir's checkout, from its `gitdir` file, only when that checkout's `.git` file points back. */
async function readLinkedCheckoutDir(
  gitDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  try {
    return await readVerifiedCheckoutDir(gitDir, toHostPath)
  } catch {
    // Unreadable or odd: Git's listing decides.
    return undefined
  }
}

async function readVerifiedCheckoutDir(
  gitDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  const named = (await readOptional(join(gitDir, 'gitdir'), MAX_GITFILE_BYTES)).replace(
    /\r?\n$/,
    ''
  )
  if (!named.endsWith('/.git')) {
    return undefined
  }
  // Git 2.48+ may write it relative to the git dir, resolved through any symlink.
  const dotGit = isAbsolute(named)
    ? toHostPath(named)
    : join(await checkedIo(() => realpath(gitDir)), named)
  const pointed = await readGitfileTarget(dotGit, toHostPath)
  return pointed && (await isSamePath(pointed, gitDir)) ? dirname(dotGit) : undefined
}

/** The checkout a sole owning git dir belongs to; undefined when the files cannot prove it. */
export async function readOwnerCheckoutPath(
  repoPath: string,
  gitDir: string,
  commonDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  if (gitDir !== commonDir) {
    return readLinkedCheckoutDir(gitDir, toHostPath)
  }
  const dotGit = join(repoPath, '.git')
  if (await isSamePath(dotGit, commonDir)) {
    return repoPath
  }
  // A separate git dir: the primary's `.git` file points straight at the common dir.
  const pointed = await readGitfileTarget(dotGit, toHostPath).catch(() => undefined)
  if (pointed && (await isSamePath(pointed, commonDir))) {
    return repoPath
  }
  // From a linked repo path: the primary checkout holds the common dir as its `.git`.
  return basename(commonDir) === '.git' ? dirname(commonDir) : undefined
}
