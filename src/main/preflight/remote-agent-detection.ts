import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../shared/tui-agent-detection-commands'
import type { TuiAgentDetectionCommand } from '../../shared/tui-agent-detection-commands'

function uniqueAgentIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
}

export async function detectRemoteAgents(args: {
  connectionId: string
  commands?: readonly TuiAgentDetectionCommand[]
  requireAvailable?: boolean
}): Promise<string[]> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    if (args.requireAvailable) {
      throw Object.assign(new Error('The remote execution host is unavailable.'), {
        code: 'remote_runtime_unavailable'
      })
    }
    return []
  }
  try {
    const result = (await mux.request('preflight.detectAgents', {
      commands: args.commands ?? KNOWN_TUI_AGENT_DETECTION_COMMANDS
    })) as { agents: string[] }
    return uniqueAgentIds(result.agents)
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    const transportFailure =
      mux.isDisposed() ||
      code === 'CONNECTION_LOST' ||
      code === 'DISPOSED' ||
      code === 'SSH_MUX_REQUEST_TIMEOUT' ||
      (error instanceof Error && /connection|timed? out/i.test(error.message))
    if (args.requireAvailable && transportFailure) {
      throw Object.assign(new Error('The remote execution host is unavailable.'), {
        code: 'remote_runtime_unavailable',
        cause: error
      })
    }
    throw error
  }
}
