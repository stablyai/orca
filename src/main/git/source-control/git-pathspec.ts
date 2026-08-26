import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS
} from '../../../shared/windows-command-line-budget'
import { resolveGitCommandWithoutProbe } from '../command-runner/git-command-resolution'
import type { GitRuntimeOptions } from '../git-runtime-options'

/** Ceiling on argv entries per invocation; under WSL the byte budget bites first. */
const BULK_CHUNK_SIZE = 100

/**
 * POSIX hosts have no CreateProcess cap: ARG_MAX is 256KB on macOS and 2MB on
 * Linux, shared with the environment block. Half the macOS floor keeps a native
 * or SSH-host invocation clear of E2BIG without charging it the WSL wrapper's
 * quoting overhead, which is a different transport's problem.
 */
const POSIX_COMMAND_LINE_BUDGET = 128_000

function normalizeGitPathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function literalPathspec(filePath: string, options: GitRuntimeOptions): string {
  // Why: Git inside WSL needs POSIX paths, but host paths must stay literal, so convert backslashes only for WSL.
  const runtimePath = options.wslDistro ? filePath.replace(/\\/g, '/') : filePath
  return `:(literal)${runtimePath}`
}

export function isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
  const normalized = normalizeGitPathForCompare(filePath)
  return trackedPaths.some((trackedPath) => {
    const normalizedTracked = normalizeGitPathForCompare(trackedPath)
    return normalizedTracked === normalized || normalizedTracked.startsWith(`${normalized}/`)
  })
}

/**
 * Length of the line the OS will actually be handed, wrapper included.
 *
 * Why resolve rather than estimate: a WSL-routed write goes through the login
 * shell, which shell-quotes every pathspec, quotes the resulting command line
 * again, and embeds that three times (one branch per guest shell). The finished
 * line runs ~3.4x the raw pathspec bytes, and nothing about the path list says
 * so. Writes never take the direct-git lane, so this is the exact shape they
 * get; a read that does take it resolves shorter, so the estimate stays safe.
 */
function finishedCommandLineLength(
  args: readonly string[],
  worktreePath: string,
  options: GitRuntimeOptions
): number {
  const resolved = resolveGitCommandWithoutProbe([...args], {
    cwd: worktreePath,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
  })
  return commandLineLength([resolved.binary, ...resolved.args])
}

/**
 * Split a bulk pathspec operation into invocations the host can actually spawn.
 *
 * Why a byte budget and not a path count: 100 was chosen against a raw argv, but
 * a WSL-routed `git add` is folded into one login-shell command line, so 100
 * ordinary paths reached ~43,000 characters -- past the 32,767 CreateProcess cap
 * -- and the bulk stage failed with nothing staged. Cost is measured per
 * pathspec through the real resolver so the wrapper's quoting rules live in one
 * place.
 *
 * Chunks split only between whole pathspecs, and a pathspec that alone exceeds
 * the budget still ships alone rather than being dropped or truncated. If an
 * invocation fails partway through, the earlier chunks stay applied: every
 * operation here is idempotent and per-path, so `git status` shows the true
 * state and re-running converges.
 */
export function bulkPathspecCommands(
  leadingArgs: readonly string[],
  filePaths: readonly string[],
  worktreePath: string,
  options: GitRuntimeOptions
): string[][] {
  // Budget belongs to the host that spawns; the overhead measured above belongs to the transport.
  const budget = process.platform === 'win32' ? MAX_COMMAND_LINE_CHARS : POSIX_COMMAND_LINE_BUDGET
  const baseLength = finishedCommandLineLength(leadingArgs, worktreePath, options)
  const commands: string[][] = []
  let pathspecs: string[] = []
  let length = baseLength
  for (const filePath of filePaths) {
    const pathspec = literalPathspec(filePath, options)
    const cost =
      finishedCommandLineLength([...leadingArgs, pathspec], worktreePath, options) - baseLength
    if (pathspecs.length > 0 && (pathspecs.length >= BULK_CHUNK_SIZE || length + cost > budget)) {
      commands.push([...leadingArgs, ...pathspecs])
      pathspecs = []
      length = baseLength
    }
    pathspecs.push(pathspec)
    length += cost
  }
  if (pathspecs.length > 0) {
    commands.push([...leadingArgs, ...pathspecs])
  }
  return commands
}
