import { StructuredAgentArgumentsError } from '../../../native-chat/structured-agent-arguments-error'

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

/** Boolean flags take no value, so tokens absorbed after them are positionals, not flag values. */
const VALUELESS_FLAGS = new Set([
  'ax-screen-reader',
  'bare',
  'bg',
  'background',
  'brief',
  'chrome',
  'desktop',
  'disable-slash-commands',
  'exclude-dynamic-system-prompt-sections',
  'forward-subagent-text',
  'ide',
  'include-hook-events',
  'no-chrome',
  'restricted',
  'safe-mode',
  'strict-mcp-config'
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
export function claudeStructuredLaunchArgs(
  args: readonly string[],
  options?: { skipUnexpressible?: boolean }
): {
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
        if (options?.skipUnexpressible) {
          continue
        }
        throw new StructuredAgentArgumentsError('Claude', '--add-dir', 'missingValue')
      }
      additionalDirectories.push(...values)
      continue
    }
    // `--flag=value` cannot round-trip for a valueless flag: the SDK emits `--flag value`, which Claude reads as a positional.
    if (options?.skipUnexpressible && VALUELESS_FLAGS.has(flag)) {
      if (separator === -1) {
        extraArgs[flag] = null
      }
      continue
    }
    // Skip mode resolves repetitions last-wins and keeps each flag's first value; absorbed tokens were positionals.
    if (!options?.skipUnexpressible && (Object.hasOwn(extraArgs, flag) || values.length > 1)) {
      throw new StructuredAgentArgumentsError('Claude', `--${flag}`, 'multipleValues')
    }
    extraArgs[flag] = values[0] ?? null
  }
  return { extraArgs, additionalDirectories }
}

/** A flag both set keeps the terminal's value: the conversation ran with it. */
export function withClaudeSourceTerminalArgs(
  configured: ReturnType<typeof claudeStructuredLaunchArgs>,
  sourceTerminalArgs: readonly string[] | undefined
): ReturnType<typeof claudeStructuredLaunchArgs> {
  if (!sourceTerminalArgs?.length) {
    return configured
  }
  const source = claudeStructuredLaunchArgs(sourceTerminalArgs, { skipUnexpressible: true })
  return {
    extraArgs: { ...configured.extraArgs, ...source.extraArgs },
    additionalDirectories: [
      ...new Set([...configured.additionalDirectories, ...source.additionalDirectories])
    ]
  }
}
