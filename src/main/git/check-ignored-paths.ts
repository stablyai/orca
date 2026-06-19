import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

const CHECK_IGNORE_CHUNK_SIZE = 100

type GitExecError = Error & { stdout?: string; code?: number | string }

function parseCheckIgnoreOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter(Boolean)
}

async function runCheckIgnoreChunk(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['-c', 'core.quotePath=false', 'check-ignore', '--', ...relativePaths],
      gitOptionsForWorktree(worktreePath, options)
    )
    return parseCheckIgnoreOutput(stdout)
  } catch (error) {
    const gitError = error as GitExecError
    if (gitError.code === 1) {
      return parseCheckIgnoreOutput(gitError.stdout ?? '')
    }
    throw error
  }
}

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const ignored = new Set<string>()
  for (let i = 0; i < relativePaths.length; i += CHECK_IGNORE_CHUNK_SIZE) {
    const chunk = relativePaths.slice(i, i + CHECK_IGNORE_CHUNK_SIZE)
    for (const ignoredPath of await runCheckIgnoreChunk(worktreePath, chunk, options)) {
      ignored.add(ignoredPath)
    }
  }
  return Array.from(ignored)
}
