import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

/** Flags supplied by the SDK or owned by Orca's structured transport. */
const OWNED_FLAGS = new Set([
  'print',
  'input-format',
  'output-format',
  'json-schema',
  'verbose',
  'resume',
  'continue',
  'session-id',
  'fork-session',
  'resume-session-at',
  'resume-drops-turn',
  'no-session-persistence',
  'session-mirror',
  'await-initialize',
  'permission-mode',
  'dangerously-skip-permissions',
  'allow-dangerously-skip-permissions',
  'permission-prompt-tool',
  'permission-prompts',
  'allowedTools',
  'disallowedTools',
  'replay-user-messages',
  'include-partial-messages',
  'setting-sources',
  'system-prompt',
  'system-prompt-file',
  'append-system-prompt',
  'append-system-prompt-file'
])

const SHORT_FLAGS: Record<string, string> = {
  '-m': 'model',
  '-d': 'debug',
  '-p': 'print',
  '-r': 'resume',
  '-c': 'continue',
  '-h': 'help',
  '-v': 'version'
}

/** Keep variadic directory options in the SDK array; scalar extraArgs cannot retain repetitions. */
export function claudeStructuredLaunchArgs(args: readonly string[]): {
  extraArgs: Record<string, string | null>
  additionalDirectories: string[]
} {
  const extraArgs: Record<string, string | null> = {}
  const additionalDirectories: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      break
    }

    const separator = arg.indexOf('=')
    const rawFlag = separator === -1 ? arg : arg.slice(0, separator)
    const flag = rawFlag.startsWith('--') ? rawFlag.slice(2) : SHORT_FLAGS[rawFlag]
    if (!flag || flag === 'help' || flag === 'version') {
      continue
    }

    const values = separator === -1 ? [] : [arg.slice(separator + 1)]
    while (args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) {
      values.push(args[++index]!)
    }
    if (OWNED_FLAGS.has(flag)) {
      continue
    }
    if (flag === 'add-dir') {
      if (values.length === 0 || values.some((value) => !value)) {
        throw new StructuredAgentArgumentsError('Claude', '--add-dir', 'missingValue')
      }
      additionalDirectories.push(...values)
      continue
    }
    if (Object.hasOwn(extraArgs, flag) || values.length > 1) {
      throw new StructuredAgentArgumentsError('Claude', `--${flag}`, 'multipleValues')
    }
    extraArgs[flag] = values[0] ?? null
  }
  return { extraArgs, additionalDirectories }
}
