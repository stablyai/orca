import { BOOLEAN_FLAGS, matches, parseArgs } from '../shared/cli-args-parser'
import {
  isLifecycleMessageType,
  ORCHESTRATION_SEND_ALLOWED_FLAGS,
  ORCHESTRATION_SEND_COMMAND_PATH
} from '../shared/orchestration-cli-contract'
import { ORCHESTRATION_SENDER_CAPABILITY_ENV } from '../shared/orchestration-sender-capability'

const ORCHESTRATION_SEND_ALLOWED_FLAG_SET = new Set(ORCHESTRATION_SEND_ALLOWED_FLAGS)

function isLifecycleSend(argv: string[]): boolean {
  // Why: flags may surround command segments, so bearer selection must share the CLI grammar.
  const parsed = parseArgs(argv, [ORCHESTRATION_SEND_COMMAND_PATH])
  if (!matches(parsed.commandPath, ORCHESTRATION_SEND_COMMAND_PATH) || parsed.flags.has('help')) {
    return false
  }
  for (const [flag, value] of parsed.flags) {
    if (
      !ORCHESTRATION_SEND_ALLOWED_FLAG_SET.has(flag) ||
      (!BOOLEAN_FLAGS.has(flag) && (typeof value !== 'string' || value.length === 0))
    ) {
      return false
    }
  }
  const type = parsed.flags.get('type')
  return typeof type === 'string' && isLifecycleMessageType(type)
}

export function pickRemoteCliEnv(
  env: NodeJS.ProcessEnv,
  argv: string[] = []
): Record<string, string> {
  const picked: Record<string, string> = {}
  const keys = [
    'ORCA_TERMINAL_HANDLE',
    'ORCA_WORKTREE_ID',
    'ORCA_PANE_KEY',
    'ORCA_WORKSPACE_ID',
    'ORCA_USER_DATA_PATH',
    'PATH',
    'Path'
  ]
  if (isLifecycleSend(argv)) {
    // Why: the bearer crosses the relay only for the lifecycle operation that consumes it.
    keys.push(ORCHESTRATION_SENDER_CAPABILITY_ENV)
  }
  for (const key of keys) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
