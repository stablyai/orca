import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { gitOptionsForWorktree } from '../git/git-runtime-options'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { gitExecFileAsync } from '../git/runner'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import type { IFilesystemProvider, IGitProvider } from '../providers/types'
import { isENOENT } from './filesystem-auth'

/** Repo-root manifest of exact relative paths of gitignored local setup files
 *  (e.g. `.env.local`, `.claude/settings.local.json`) that must exist in every
 *  new worktree before any setup script or agent starts. Mirrors Codex's
 *  `.worktreeinclude` contract: the harness itself honors it at creation time,
 *  so it cannot be skipped, raced, or half-applied the way a setup script can. */
export const WORKTREE_INCLUDE_FILENAME = '.worktreeinclude'

const GIT_PATH_ARG_CHUNK_SIZE = 100

export type CopyAttemptOutcome = 'copied' | 'missing' | 'not-a-file' | 'destination-exists'

export type WorktreeIncludeHostOps = {
  /** Contents of `<repoRoot>/.worktreeinclude`, or null when absent. */
  readIncludeFile(): Promise<string | null>
  listTrackedPaths(relativePaths: string[]): Promise<string[]>
  listIgnoredPaths(relativePaths: string[]): Promise<string[]>
  /** Copy one repo-relative file into the worktree, creating parent
   *  directories and preserving mode; must never overwrite the destination. */
  copyFileNoClobber(relativePath: string): Promise<CopyAttemptOutcome>
}

export type RemoteWorktreeIncludeGitOps = Pick<IGitProvider, 'exec' | 'checkIgnoredPaths'>

async function listTrackedPathsChunked(
  relativePaths: string[],
  execGit: (args: string[]) => Promise<{ stdout: string }>
): Promise<string[]> {
  const trackedPaths: string[] = []
  for (let i = 0; i < relativePaths.length; i += GIT_PATH_ARG_CHUNK_SIZE) {
    const chunk = relativePaths.slice(i, i + GIT_PATH_ARG_CHUNK_SIZE)
    const { stdout } = await execGit(['ls-files', '-z', '--', ...chunk])
    trackedPaths.push(...stdout.split('\0').filter(Boolean))
  }
  return trackedPaths
}

/** True when any existing component of `relativePath` under `rootPath` is a
 *  symlink. Copying through a symlinked parent would follow the link and write
 *  the file outside the worktree, so callers reject such entries. Missing
 *  components are fine — they will be created as real directories. */
async function relativePathHasSymlinkedParent(
  rootPath: string,
  relativePath: string
): Promise<boolean> {
  const segments = relativePath.split('/').slice(0, -1)
  let current = rootPath
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true
      }
    } catch {
      // Component does not exist yet — mkdir will create it as a real dir.
      return false
    }
  }
  return false
}

export function createLocalWorktreeIncludeOps(
  repoPath: string,
  worktreePath: string,
  gitOptions: GitRuntimeOptions
): WorktreeIncludeHostOps {
  return {
    async readIncludeFile() {
      try {
        return await readFile(resolve(repoPath, WORKTREE_INCLUDE_FILENAME), 'utf8')
      } catch (error) {
        if (isENOENT(error)) {
          return null
        }
        throw error
      }
    },
    async listTrackedPaths(relativePaths) {
      return listTrackedPathsChunked(relativePaths, (args) =>
        gitExecFileAsync(args, gitOptionsForWorktree(repoPath, gitOptions))
      )
    },
    async listIgnoredPaths(relativePaths) {
      return checkIgnoredPaths(repoPath, relativePaths, gitOptions)
    },
    async copyFileNoClobber(relativePath) {
      const source = resolve(repoPath, relativePath)
      const destination = resolve(worktreePath, relativePath)
      // Why: reject a repo-committed symlink anywhere in the source path — the
      // leaf (lstat below) or any parent component — so a link pointing outside
      // the repo (e.g. `foo -> ~/.ssh`) cannot exfiltrate host files into the
      // new worktree the agent then runs in. Same guard on the destination side
      // stops a symlinked parent from redirecting the write out of the worktree.
      if (
        (await relativePathHasSymlinkedParent(repoPath, relativePath)) ||
        (await relativePathHasSymlinkedParent(worktreePath, relativePath))
      ) {
        return 'not-a-file'
      }
      let sourceStat
      try {
        sourceStat = await lstat(source)
      } catch (error) {
        if (isENOENT(error)) {
          return 'missing'
        }
        throw error
      }
      if (!sourceStat.isFile()) {
        return 'not-a-file'
      }
      await mkdir(dirname(destination), { recursive: true })
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
          return 'destination-exists'
        }
        throw error
      }
      // Why: copyFile only carries the source mode onto brand-new files on
      // some platforms; stamp it explicitly so executable setup files stay
      // executable in the worktree. A chmod failure must not undo a completed
      // copy — the content is already in place, so keep the 'copied' outcome.
      await chmod(destination, sourceStat.mode & 0o777).catch(() => undefined)
      return 'copied'
    }
  }
}

export function createRemoteWorktreeIncludeOps(
  repoPath: string,
  worktreePath: string,
  gitProvider: RemoteWorktreeIncludeGitOps,
  fsProvider: IFilesystemProvider
): WorktreeIncludeHostOps {
  return {
    async readIncludeFile() {
      let result
      try {
        result = await fsProvider.readFile(
          joinWorktreeRelativePath(repoPath, WORKTREE_INCLUDE_FILENAME)
        )
      } catch (error) {
        // Why: the relay surfaces a missing file as a generic error; treat any
        // read failure as "no include file" so creation is never blocked. Log
        // it so a real relay/auth failure leaves a trace instead of looking
        // identical to "not configured".
        console.warn(
          `[worktree-include] Could not read ${WORKTREE_INCLUDE_FILENAME} on remote host; treating as absent:`,
          error
        )
        return null
      }
      return result.isBinary ? null : result.content
    },
    async listTrackedPaths(relativePaths) {
      return listTrackedPathsChunked(relativePaths, (args) => gitProvider.exec(args, repoPath))
    },
    async listIgnoredPaths(relativePaths) {
      return gitProvider.checkIgnoredPaths(repoPath, relativePaths)
    },
    async copyFileNoClobber(relativePath) {
      // Why: source and destination both live on the remote host, so the copy
      // happens host-side over the existing relay — file contents (which can
      // include secrets) never transit to the local machine.
      const source = joinWorktreeRelativePath(repoPath, relativePath)
      const destination = joinWorktreeRelativePath(worktreePath, relativePath)
      let sourceStat
      try {
        // Why: lstat when the relay exposes it so a symlinked source is rejected
        // (type 'symlink') rather than dereferenced — fs.stat follows the link
        // and would report a symlink-to-file as 'file', matching the local
        // exfiltration vector. Fall back to stat on relays without lstat.
        sourceStat = fsProvider.lstat
          ? await fsProvider.lstat(source)
          : await fsProvider.stat(source)
      } catch {
        return 'missing'
      }
      if (sourceStat.type !== 'file') {
        return 'not-a-file'
      }
      const parent = relativePath.split('/').slice(0, -1).join('/')
      if (parent) {
        await fsProvider.createDir(joinWorktreeRelativePath(worktreePath, parent))
      }
      try {
        // Why: the relay's fs.copy is no-clobber (errorOnExist) and preserves
        // file mode, giving remote copies the same guarantees as local ones.
        await fsProvider.copy(source, destination)
      } catch (error) {
        if (error instanceof Error && error.message.includes('EEXIST')) {
          return 'destination-exists'
        }
        throw error
      }
      return 'copied'
    }
  }
}
