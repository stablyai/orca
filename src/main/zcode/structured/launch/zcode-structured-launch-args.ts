import { StructuredAgentArgumentsError } from '../../../native-chat/agent-launch/structured-agent-arguments-error'

// zcode chats run `app-server --stdio`: prompts, permission modes and output formats are
// session RPC territory, so the chat accepts only root options that cannot redirect them.
const DROPPED_VALUE_OPTIONS = new Set([
  '-p',
  '--prompt',
  '--target',
  '--output-format',
  '--surface',
  '--memory-bench'
])

const DROPPED_SWITCHES = new Set(['--headless', '--help', '-h', '--version', '-V'])

function optionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]!
  }
  if (token === '-p') {
    return '-p'
  }
  return token
}

function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2)
}

export function zcodeStructuredLaunchArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      // A trailing positional after -- is the saved prompt this transport cannot deliver.
      if (tokens.slice(index + 1).some((t) => t.trim().length > 0)) {
        throw new Error('zcode launch arguments cannot carry a prompt after --')
      }
      break
    }
    const option = optionName(token)
    if (DROPPED_SWITCHES.has(option)) {
      continue
    }
    if (DROPPED_VALUE_OPTIONS.has(option)) {
      const value = inlineValue(token, option) ?? tokens[++index]
      if (!value || value === '--' || (value.startsWith('-') && !token.includes('='))) {
        throw new StructuredAgentArgumentsError('ZCode', option, 'missingValue')
      }
      continue
    }
    if (!token.startsWith('-')) {
      throw new StructuredAgentArgumentsError('ZCode', token, 'positionalPrompt')
    }
    throw new StructuredAgentArgumentsError('ZCode', token, 'unsupportedOption')
  }
  return args
}
