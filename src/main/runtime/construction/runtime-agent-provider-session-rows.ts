import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'
import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'

export abstract class OrcaRuntimeWithAgentProviderSessionRows extends OrcaRuntimeWithTerminalDrivers {
  protected readonly getAgentProviderSessionSnapshotFn!:
    | HostBindings['getAgentProviderSessionSnapshot']
    | null

  protected readonly getAgentProviderSessionRowsForPaneFn!:
    | HostBindings['getAgentProviderSessionRowsForPane']
    | null

  /** Includes resume-identity-only provider rows. */
  getAgentProviderSessionRows(): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionSnapshotFn?.() ?? []
  }

  getAgentStatusRowsForPane(paneKey: string): AgentStatusIpcPayload[] {
    return this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
  }
}
