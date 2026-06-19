export function shouldReadRemoteCliStdin(argv: string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    return false
  }
  const commandPath = parseRemoteCliCommandPath(argv)
  if (!isLinearBodyWriteCommand(commandPath)) {
    return false
  }
  return argv.some((part, index) => {
    if (part === '--body-file') {
      return argv[index + 1] === '-'
    }
    return part === '--body-file=-'
  })
}

const REMOTE_STDIN_BOOLEAN_FLAGS = new Set(['current', 'help', 'json', 'parent-current'])

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
  return (commandPath[1] === 'comment' && commandPath[2] === 'add') || commandPath[1] === 'create'
}
