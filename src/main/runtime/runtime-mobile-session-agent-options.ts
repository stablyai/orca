import type { TuiAgent } from '../../shared/tui-agent'
import { orderDetectedTuiAgents } from '../../shared/tui-agent-selection'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'

export async function loadRuntimeMobileSessionAgentOptions(
  connectionId: string | null,
  settings: { defaultTuiAgent?: TuiAgent | 'blank' | null; disabledTuiAgents?: unknown }
): Promise<TuiAgent[]> {
  const detected = connectionId
    ? await detectRemoteAgents({ connectionId })
    : await detectInstalledAgentsWithShellPathHydration()
  return orderDetectedTuiAgents(settings.defaultTuiAgent, detected, settings.disabledTuiAgents)
}
