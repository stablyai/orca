import { isTuiAgent } from '../../shared/tui-agent-config'
import { RuntimeClientError } from '../runtime-client'

export function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && (options.allowEmpty || value.length > 0)) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export function getOptionalStartupAgent(flags: Map<string, string | boolean>): string | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    return undefined
  }
  if (!isTuiAgent(agent)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${agent}"`)
  }
  return agent
}

export function getOptionalSetupDecision(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true) {
    if (setup !== undefined && setup !== 'run') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose either --run-hooks or --setup run, not contradictory setup flags.'
      )
    }
    return setup
  }
  return setup
}
