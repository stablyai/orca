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
  'check-ref-format',
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

// Read markers that appear as a flag anywhere after the subcommand.
const READ_FLAG_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  branch: new Set([
    '--list',
    '-l',
    '--show-current',
    '--contains',
    '--points-at',
    '--all',
    '-a',
    '--remotes',
    '-r'
  ]),
  config: new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])
}

const BRANCH_MUTATION_FLAGS = new Set([
  '--copy',
  '--create-reflog',
  '--delete',
  '--edit-description',
  '--force',
  '--move',
  '--no-create-reflog',
  '--no-track',
  '--recurse-submodules',
  '--set-upstream-to',
  '--track',
  '--unset-upstream'
])
const BRANCH_MUTATION_SHORT_FLAGS = new Set(['c', 'C', 'd', 'D', 'f', 'm', 'M', 't', 'u'])

function hasBranchMutationFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    const flag = arg.split('=')[0]
    if (BRANCH_MUTATION_FLAGS.has(flag)) {
      return true
    }
    return (
      /^-[^-]/.test(flag) &&
      flag
        .slice(1)
        .split('')
        .some((part) => BRANCH_MUTATION_SHORT_FLAGS.has(part))
    )
  })
}

// Read markers that must be the *first non-flag* argument, i.e. the action.
// Position matters here: matching them anywhere would read `worktree remove list`
// as a listing, because a worktree may legitimately be named "list".
const READ_ACTION_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  remote: new Set(['get-url']),
  submodule: new Set(['status']),
  worktree: new Set(['list'])
}

// Subcommands whose action-less form only lists (`git remote`, `git submodule`).
const BARE_FORM_IS_READ = new Set(['remote', 'submodule'])

/** Leading `-c key=value` / `--git-dir=...` style options precede the subcommand. */
export function findGitSubcommandIndex(args: readonly string[]): number {
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
  const subcommandIndex = findGitSubcommandIndex(args)
  if (subcommandIndex === -1) {
    return false
  }
  const subcommand = args[subcommandIndex]
  if (ALWAYS_READ_SUBCOMMANDS.has(subcommand)) {
    return true
  }
  const rest = args.slice(subcommandIndex + 1)

  if (subcommand === 'symbolic-ref') {
    if (rest.some((arg) => arg === '-d' || arg === '--delete' || arg === '-m')) {
      return false
    }
    // Reading takes one ref; a second positional is the value being written.
    return rest.filter((arg) => arg !== '--' && !arg.startsWith('-')).length <= 1
  }

  if (subcommand === 'branch' && hasBranchMutationFlag(rest)) {
    return false
  }

  const readActions = READ_ACTION_SUBCOMMANDS[subcommand]
  if (readActions) {
    const action = rest.find((arg) => !arg.startsWith('-'))
    if (!action) {
      return BARE_FORM_IS_READ.has(subcommand)
    }
    // `remote show` queries the transport unless -n is given, so the queried
    // form has to keep the profile's SSH and credential setup.
    if (subcommand === 'remote' && action === 'show') {
      return rest.includes('-n')
    }
    return readActions.has(action)
  }

  const readFlags = READ_FLAG_SUBCOMMANDS[subcommand]
  return Boolean(readFlags && rest.some((arg) => readFlags.has(arg.split('=')[0])))
}

export type GitCommandClass = 'network' | 'read' | 'other'

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote'])

function positionalAction(args: readonly string[], subcommandIndex: number): string | undefined {
  return args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith('-'))
}

/** Classify only commands whose dominant phase is remote transfer as network work. */
export function classifyGitCommand(args: readonly string[]): GitCommandClass {
  const subcommandIndex = findGitSubcommandIndex(args)
  if (subcommandIndex === -1) {
    return 'other'
  }
  const subcommand = args[subcommandIndex]
  if (NETWORK_SUBCOMMANDS.has(subcommand)) {
    return 'network'
  }
  const action = positionalAction(args, subcommandIndex)
  if (
    (subcommand === 'submodule' && action === 'update') ||
    (subcommand === 'remote' && action === 'update')
  ) {
    return 'network'
  }
  return isWslDirectGitReadCommand(args) ? 'read' : 'other'
}
