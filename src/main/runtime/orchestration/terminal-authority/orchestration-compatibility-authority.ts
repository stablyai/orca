import type { WorkerTerminalHostScope } from '../../../../shared/worker-terminal-host-scope'
import type { OrchestrationCompatibilityHostStamp } from '../../../../shared/orchestration-compatibility-evidence'

export type OrchestrationCompatibilityTerminalAuthority = {
  runtimeId: string
  terminalHandle: string
  ptyId: string
  worktreeId: string
  processIncarnation: string | null
  paneKey: string | null
  launchTokenHash: string | null
  hostScope: WorkerTerminalHostScope
}

export type OrchestrationCompatibilityCallerAuthority = Readonly<{
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
  paneKey: string
  terminalHandle: string
  processIncarnation: string
  launchTokenHash: string
}>

export type RestoredOrchestrationAuthorityReceipt = Readonly<{
  ptyId: string
  worktreeId: string
  terminalHandle: string
  paneKey: string
  processIncarnation: string
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
}>

export type OrchestrationCompatibilitySshAttachmentAuthority = Extract<
  OrchestrationCompatibilityHostStamp,
  { kind: 'ssh' }
>

/** COMPAT(legacy-relay-bridge): bridge verifies an unhosted relay-era terminal only for this CLI attachment lifetime. */
export type OrchestrationCompatibilitySshTerminal = Readonly<{
  handle: string
  paneKey: string
  processIncarnation?: string
}>
