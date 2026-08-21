const LINEAR_STDIN_FILE_FLAGS = ['--body-file', '--content-file']

export function shouldReadRemoteCliStdin(argv: string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    return false
  }
  // Why: computer-use style flags (`--text-stdin`, ...) declare a stdin
  // payload directly in the flag name; the full-CLI bridge (#7716) must
  // forward stdin for them the same way local shells provide it.
  if (argv.some((part) => /^--[a-z0-9][a-z0-9-]*-stdin(?:=|$)/.test(part))) {
    return true
  }
  const commandPath = parseRemoteCliCommandPath(argv)
  if (!isLinearBodyWriteCommand(commandPath)) {
    return false
  }
  return argv.some((part, index) =>
    LINEAR_STDIN_FILE_FLAGS.includes(part)
      ? argv[index + 1] === '-'
      : LINEAR_STDIN_FILE_FLAGS.some((flag) => part === `${flag}=-`)
  )
}

// Why: a boolean flag directly followed by a bare positional (not another
// `--flag`) would otherwise have that positional mistaken for its value,
// shifting the command-path scan out of alignment. Every no-value flag on the
// Linear write commands this scan cares about has to be listed here, or a
// piped body can silently stop being forwarded over the relay.
const REMOTE_STDIN_BOOLEAN_FLAGS = new Set([
  'current',
  'help',
  'json',
  'parent-current',
  'hide-diff',
  'clear-description',
  'clear-content',
  'clear-lead',
  'clear-members',
  'clear-labels',
  'clear-start-date',
  'clear-target-date'
])

function parseRemoteCliCommandPath(argv: string[]): string[] {
  const commandPath: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const assignment = token.slice(2)
    if (assignment.includes('=')) {
      continue
    }
    const next = argv[index + 1]
    if (!REMOTE_STDIN_BOOLEAN_FLAGS.has(assignment) && next && !next.startsWith('--')) {
      index += 1
    }
  }
  return commandPath
}

function isLinearBodyWriteCommand(commandPath: string[]): boolean {
  if (commandPath[0] !== 'linear') {
    return false
  }
  if (commandPath[1] === 'project') {
    // Why: the relay only forwards stdin for commands listed here, so every
    // Linear write that accepts `-` has to be named or its `-` form reads nothing.
    return (
      commandPath[2] === 'create' ||
      commandPath[2] === 'edit' ||
      (commandPath[2] === 'update' && commandPath[3] === 'add')
    )
  }
  return (
    (commandPath[1] === 'comment' && commandPath[2] === 'add') ||
    commandPath[1] === 'create' ||
    commandPath[1] === 'save-issue'
  )
}
