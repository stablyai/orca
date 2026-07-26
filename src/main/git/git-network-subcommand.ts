// Why: `git -c a=b -c c=d fetch …` is the shape worktree-create fetches use, so
// the subcommand has to be found past any leading global options rather than
// read off args[0].
const GLOBAL_OPTIONS_TAKING_A_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace'
])

/** Subcommands that always contact a remote. */
const NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push', 'submodule'])

/** `git remote <verb>` verbs that contact a remote; the rest are local reads. */
const NETWORK_REMOTE_VERBS = new Set(['prune', 'update'])

function findSubcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) {
      return i
    }
    if (GLOBAL_OPTIONS_TAKING_A_VALUE.has(arg)) {
      i += 1
    }
  }
  return -1
}

/**
 * Whether this git invocation talks to a remote, and therefore needs the user's
 * login-shell environment (SSH_AUTH_SOCK from the agent the profile starts, a
 * profile-set GIT_SSH_COMMAND, credential helpers on a profile-added PATH).
 */
export function isNetworkGitCommand(args: string[]): boolean {
  const index = findSubcommandIndex(args)
  if (index === -1) {
    return false
  }
  const subcommand = args[index]
  if (subcommand === 'remote') {
    return args.slice(index + 1).some((arg) => NETWORK_REMOTE_VERBS.has(arg))
  }
  return NETWORK_SUBCOMMANDS.has(subcommand)
}
