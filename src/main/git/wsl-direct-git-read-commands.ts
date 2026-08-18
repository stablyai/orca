/**
 * Decide whether a git invocation is a plain read that can run without a shell.
 *
 * Why: WSL-routed git otherwise goes through the distro user's interactive login
 * shell, purely to inherit their PATH. That shell also runs the distro's rc/motd
 * and writes it to the stdout callers parse. Reads need none of it -- the direct
 * route supplies PATH and HOME explicitly and starts no shell at all.
 *
 * Writes and network operations stay on the login shell: they can depend on
 * credential helpers, ssh-agent and other environment only the user's profile
 * sets up.
 */

// Subcommands that only ever read. `status` is here for completeness; its
// callers already opted in explicitly.
const ALWAYS_READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'describe',
  'diff',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'var'
])

// Subcommands that read or write depending on their flags. Each needs an
// explicit read flag before it can skip the shell.
const CONDITIONAL_READ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  branch: new Set(['--list', '-l', '--show-current', '--contains', '--points-at']),
  config: new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']),
  remote: new Set(['get-url', '-v', '--verbose', 'show']),
  submodule: new Set(['status'])
}

/** Leading `-c key=value` / `--git-dir=...` style options precede the subcommand. */
function findSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-c' || arg === '-C') {
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    return index
  }
  return -1
}

export function isWslDirectGitReadCommand(args: readonly string[]): boolean {
  const subcommandIndex = findSubcommandIndex(args)
  if (subcommandIndex === -1) {
    return false
  }
  const subcommand = args[subcommandIndex]
  if (ALWAYS_READ_SUBCOMMANDS.has(subcommand)) {
    return true
  }
  const readFlags = CONDITIONAL_READ_SUBCOMMANDS[subcommand]
  return Boolean(
    readFlags &&
      args
        .slice(subcommandIndex + 1)
        .some((arg) => readFlags.has(arg) || readFlags.has(arg.split('=')[0]))
  )
}
