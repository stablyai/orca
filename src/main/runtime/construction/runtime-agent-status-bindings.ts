import type { RuntimeConstructionBindings as HostBindings } from './runtime-construction-dependencies'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { OrcaRuntimeWithTerminalDrivers } from '../terminal/driver/terminal-driver-resources'

export abstract class OrcaRuntimeWithAgentStatusBindings extends OrcaRuntimeWithTerminalDrivers {
  protected readonly onTerminalAgentStatus!: HostBindings['onTerminalAgentStatus'] | null

  protected readonly onTerminalProgramStatusFacet!:
    | HostBindings['onTerminalProgramStatusFacet']
    | null

  protected readonly onTerminalSideEffects!: HostBindings['onTerminalSideEffects'] | null

  protected readonly onClaudeTerminalEvidence!: HostBindings['onClaudeTerminalEvidence'] | null
  protected readonly onJcodeTerminalTitle!: HostBindings['onJcodeTerminalTitle'] | null

  protected terminalSideEffectLocalConsumerAvailable = false

  protected terminalSideEffectConsumerAvailable = false

  readonly getAgentStatusSnapshotFn!: HostBindings['getAgentStatusSnapshot'] | null

  protected readonly structuredAgentStatusSinkFn!: HostBindings['structuredAgentStatusSink'] | null

  readonly readObservedAgentStatusPaneIdentityFn!: HostBindings['readObservedAgentStatusPaneIdentity']

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
