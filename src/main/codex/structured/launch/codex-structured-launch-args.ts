import { CODEX_PERMISSION_CONFIG_ROOTS } from '../../../../shared/agent-launch/permissions/agent-permission-args'
import { parseTomlKeyPath } from '../../configuration/toml/config-toml-key-path'
import {
  CODEX_DROPPED_SWITCHES as DROPPED_SWITCHES,
  CODEX_DROPPED_VALUE_OPTIONS as DROPPED_VALUE_OPTIONS,
  CODEX_PASSTHROUGH_SWITCHES as PASSTHROUGH_SWITCHES,
  CODEX_REMOTE_OPTIONS,
  CODEX_VALUE_OPTIONS as VALUE_OPTIONS,
  codexOptionName as optionName
} from '../../../../shared/agent-launch/catalog/codex-cli-value-options'
import { StructuredAgentArgumentsError } from '../../../native-chat/agent-launch/structured-agent-arguments-error'

function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2)
}

function isPermissionConfig(value: string): boolean {
  const key = parseTomlKeyPath(value)?.segments[0]
  return CODEX_PERMISSION_CONFIG_ROOTS.some((root) => root === key)
}

/** Accept only root CLI options; Orca sets permissions on the thread RPC. */
export function codexStructuredLaunchArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      break
    }
    const option = optionName(token)
    if (CODEX_REMOTE_OPTIONS.has(option)) {
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
