import type { DetectedAgentExecutables } from '../../shared/detected-agent-executables'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { detectInstalledAgents } from './agent-detection'
import { getHostAgentExecutableSnapshot } from './host-agent-executables'

/** Executables matched by the last host detection; null for WSL runtimes. */
export async function detectInstalledAgentExecutables(
  context?: PreflightRuntimeContext
): Promise<DetectedAgentExecutables | null> {
  if (getPreflightWslTarget(context)) {
    return null
  }
  if (!getHostAgentExecutableSnapshot()) {
    await detectInstalledAgents(context)
  }
  return getHostAgentExecutableSnapshot() ?? {}
}
