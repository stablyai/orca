const LINEAR_ISSUE_CONTEXT_TIMEOUT_MS = 120_000
const REMOTE_TIMEOUT_BOOLEAN_FLAGS = new Set([
  'all',
  'attachments',
  'children',
  'comments',
  'current',
  'full',
  'help',
  'inject',
  'json',
  'relations',
  'unread',
  'wait'
])

export function remoteCliRequestTimeoutMs(params: Record<string, unknown>): number | undefined {
  return isLinearCliRequest(params) ? LINEAR_ISSUE_CONTEXT_TIMEOUT_MS : undefined
}

function isLinearCliRequest(params: Record<string, unknown>): boolean {
  const argv = params.argv
  if (!Array.isArray(argv) || !argv.every((part) => typeof part === 'string')) {
    return false
  }
  const commandPath = parseRemoteCommandPath(argv)
  return commandPath.some(
    (part, index) => part === 'linear' && ['issue', 'search'].includes(commandPath[index + 1] ?? '')
  )
}

function parseRemoteCommandPath(argv: string[]): string[] {
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
    if (!REMOTE_TIMEOUT_BOOLEAN_FLAGS.has(assignment) && next && !next.startsWith('--')) {
      index += 1
    }
  }
  return commandPath
}
