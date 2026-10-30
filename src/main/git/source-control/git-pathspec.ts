import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS
} from '../../../shared/windows-command-line-budget'
import {
  resolveGitCommandWithoutProbe,
  wslDistroForCommand
} from '../command-runner/git-command-resolution'
import { WINDOWS_CHECKOUT_GIT_CONFIG_ARGS } from '../wsl-windows-checkout-git-config'
import type { GitRuntimeOptions } from '../git-runtime-options'

/** Ceiling on argv entries per invocation; under WSL the byte budget bites first. */
const BULK_CHUNK_SIZE = 100

// Use half macOS's 256KB ARG_MAX floor, leaving space for the environment on native and SSH hosts.
const POSIX_COMMAND_LINE_BUDGET = 128_000

export function literalPathspec(
  filePath: string,
  worktreePath: string,
  options: GitRuntimeOptions
): string {
  // Convert separators only for WSL, including UNC cwd routing; native host paths stay literal.
  const runsInWsl = options.wslDistro || wslDistroForCommand(worktreePath)
  const runtimePath = runsInWsl ? filePath.replace(/\\/g, '/') : filePath
  return `:(literal)${runtimePath}`
}

/** Measure the resolved line: WSL login wrappers quote and repeat pathspecs, multiplying raw argv length. */
function finishedCommandLineLength(
  args: readonly string[],
  worktreePath: string,
  options: GitRuntimeOptions
): number {
  // Include config that Windows-checkout routing may add after chunking.
  const budgetArgs = options.wslDistro ? [...WINDOWS_CHECKOUT_GIT_CONFIG_ARGS, ...args] : [...args]
  const resolved = resolveGitCommandWithoutProbe(budgetArgs, {
    cwd: worktreePath,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
  })
  return commandLineLength([resolved.binary, ...resolved.args])
}

/**
 * Split at whole pathspecs using the resolved command-line budget; oversized single paths still ship alone.
 * Earlier chunks remain applied on failure; per-path operations are idempotent, so retrying converges.
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
    const pathspec = literalPathspec(filePath, worktreePath, options)
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
