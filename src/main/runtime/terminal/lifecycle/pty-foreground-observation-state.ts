import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { TerminalForegroundObservation } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'

export type PtyForegroundAgentRefresh = {
  promise: Promise<boolean>
  startedAfterTitleObservation: number
  requestedAfterTitleObservation: number
}

export type PtyForegroundProcessRead = {
  controller: RuntimePtyController
  process: string | null
  agent?: TerminalAgent
  available: boolean
  observation?: TerminalForegroundObservation
  unsupported?: boolean
}

export type PtyForegroundProcessReadEntry = {
  controller: RuntimePtyController
  startedAfterTitleObservation: number
  promise: Promise<PtyForegroundProcessRead>
  observationGeneration?: object
  isCurrent(): boolean
}
