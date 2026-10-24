import type { TuiAgent } from '../../shared/tui-agent'
import { parseCliAgent } from '../agent-launch-request'
import { RuntimeClientError } from '../runtime-client'

function getPresentStringFlag(
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

export function getOptionalStartupAgent(
  flags: Map<string, string | boolean>
): TuiAgent | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    const needsAgent = ['prompt', 'model', 'effort', 'surface', 'retry-launch'].find((name) =>
      flags.has(name)
    )
    if (needsAgent) {
      throw new RuntimeClientError('invalid_argument', `--${needsAgent} requires --agent`)
    }
    return undefined
  }
  return parseCliAgent(agent)
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
