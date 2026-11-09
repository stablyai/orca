import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { parseCliAgent } from '../agent-launch-request'
import { getPresentStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

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
