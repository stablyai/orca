// Only root CLI options can precede `app-server`. A prompt or another subcommand
// would change the process Orca starts, and permission options belong to Orca.
import { parseTomlKeyPath } from './config-toml-key-path'
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-m',
  '--model',
  '--local-provider'
])

const DROPPED_VALUE_OPTIONS = new Set([
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image'
])

const DROPPED_SWITCHES = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--approve-for-me',
  '--not-so-yolo',
  '--dangerously-bypass-hook-trust',
  '--worktree',
  '--strict-config',
  '--help',
  '-h',
  '--version',
  '-V'
])

const PASSTHROUGH_SWITCHES = new Set(['--search', '--oss', '--no-alt-screen', '--no-daemon'])

function optionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]
  }
  if (/^-[acmspiC].+/.test(token)) {
    return token.slice(0, 2)
  }
  return token
}

function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2)
}

function isPermissionConfig(value: string): boolean {
  const key = parseTomlKeyPath(value)?.segments[0]
  return (
    key === 'approval_policy' ||
    key === 'sandbox_mode' ||
    key === 'approvals_reviewer' ||
    key === 'sandbox_workspace_write'
  )
}

/** Turns saved terminal Arguments into root options for a structured app-server launch. */
export function codexStructuredLaunchArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      break
    }
    const option = optionName(token)
    if (option === '--remote' || option === '--remote-auth-token-env') {
      throw new StructuredAgentArgumentsError('Codex', option, 'unsupportedOption')
    }
    if (DROPPED_SWITCHES.has(option)) {
      continue
    }
    if (PASSTHROUGH_SWITCHES.has(option) && token === option) {
      args.push(token)
      continue
    }
    if (VALUE_OPTIONS.has(option) || DROPPED_VALUE_OPTIONS.has(option)) {
      const value = inlineValue(token, option) ?? tokens[++index]
      if (!value || value === '--' || (value.startsWith('-') && !token.includes('='))) {
        throw new StructuredAgentArgumentsError('Codex', option, 'missingValue')
      }
      if (
        DROPPED_VALUE_OPTIONS.has(option) ||
        (['-c', '--config'].includes(option) && isPermissionConfig(value))
      ) {
        continue
      }
      args.push(token)
      if (token === option) {
        args.push(value)
      }
      continue
    }
    if (!token.startsWith('-')) {
      throw new StructuredAgentArgumentsError('Codex', token, 'positionalPrompt')
    }
    throw new StructuredAgentArgumentsError('Codex', token, 'unsupportedOption')
  }
  return args
}
