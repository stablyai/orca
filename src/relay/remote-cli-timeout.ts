// Why: the host bridges the full Orca CLI over the relay (#7716), so mutation
// commands (worktree create, orchestration dispatch, Linear writes, ...) can
// legitimately outlive the relay's 30 s default request timeout. Long-poll
// commands carry their waiter budget in --timeout-ms; extend past it so the
// host-side CLI produces its proper timeout error instead of the relay
// cutting the request short.
const REMOTE_CLI_DEFAULT_TIMEOUT_MS = 5 * 60_000
const REMOTE_CLI_WAIT_TIMEOUT_MS = 10 * 60_000
const REMOTE_CLI_TIMEOUT_GRACE_MS = 60_000

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
  const argv = getStringArgv(params)
  if (!argv) {
    return undefined
  }
  const base = isWaitStyleCliRequest(argv)
    ? REMOTE_CLI_WAIT_TIMEOUT_MS
    : REMOTE_CLI_DEFAULT_TIMEOUT_MS
  const explicit = parseTimeoutMsFlag(argv)
  if (explicit !== null && explicit > 0) {
    return Math.max(base, explicit + REMOTE_CLI_TIMEOUT_GRACE_MS)
  }
  return base
}

function isWaitStyleCliRequest(argv: string[]): boolean {
  if (argv.includes('--wait')) {
    return true
  }
  const commandPath = parseRemoteCommandPath(argv)
  return (
    (commandPath[0] === 'terminal' && commandPath[1] === 'wait') ||
    (commandPath[0] === 'orchestration' && commandPath[1] === 'ask')
  )
}

function parseTimeoutMsFlag(argv: string[]): number | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    let raw: string | undefined
    if (token === '--timeout-ms') {
      raw = argv[index + 1]
    } else if (token.startsWith('--timeout-ms=')) {
      raw = token.slice('--timeout-ms='.length)
    } else {
      continue
    }
    const parsed = raw === undefined ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getStringArgv(params: Record<string, unknown>): string[] | null {
  const argv = params.argv
  if (!Array.isArray(argv) || !argv.every((part) => typeof part === 'string')) {
    return null
  }
  return argv
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
