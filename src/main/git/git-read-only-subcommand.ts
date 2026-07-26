// Why: `git -c a=b -c c=d status …` is the shape status reads use, so the
// subcommand has to be found past leading global options rather than args[0].
const GLOBAL_OPTIONS_TAKING_A_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace'
])

const READ_ONLY_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'describe',
  'diff',
  'diff-tree',
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
  'status'
])

function findSubcommand(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('-')) {
      return arg
    }
    if (GLOBAL_OPTIONS_TAKING_A_VALUE.has(arg)) {
      index += 1
    }
  }
  return null
}

/** Commands safe to run with only the captured login-shell PATH. */
export function isReadOnlyGitCommand(args: string[]): boolean {
  const subcommand = findSubcommand(args)
  return subcommand !== null && READ_ONLY_SUBCOMMANDS.has(subcommand)
}
