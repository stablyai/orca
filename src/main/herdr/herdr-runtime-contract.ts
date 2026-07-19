import type { HerdrExternalRef } from '../../shared/herdr-session-identity'

export const HERDR_MINIMUM_PROTOCOL_VERSION = 17

export type HerdrServerCapabilities = {
  protocol: number
  external_refs: boolean
  resumable_events: boolean
  portable_layouts: boolean
  terminal_control_v2: boolean
  terminal_history: boolean
  controller_takeover: boolean
  pane_restart: boolean
}

export type HerdrWorkspace = {
  workspace_id: string
  label?: string
  worktree?: { checkout_path: string }
  external_ref?: HerdrExternalRef
}

export type HerdrTab = {
  tab_id: string
  workspace_id: string
  label?: string
  external_ref?: HerdrExternalRef
}

export type HerdrPane = {
  pane_id: string
  tab_id: string
  workspace_id: string
  external_ref?: HerdrExternalRef
}

export type HerdrSessionSnapshot = {
  protocol: number
  capabilities: Omit<HerdrServerCapabilities, 'protocol'>
  graph_revision: number
  workspaces: HerdrWorkspace[]
  tabs: HerdrTab[]
  panes: HerdrPane[]
}

export type HerdrResponse<T> =
  | { id: string; result: T }
  | { id: string; error: { code: string; message: string } }

export type HerdrTerminalFrame = {
  type: 'terminal.frame'
  seq: number
  encoding: 'ansi'
  width: number
  height: number
  full: boolean
  bytes: string
}

export type HerdrTerminalClosed = {
  type: 'terminal.closed'
  reason: string
}

export type HerdrTerminalController = {
  write(data: string): void
  resize(cols: number, rows: number): void
  release(): void
  onFrame(listener: (frame: HerdrTerminalFrame) => void): () => void
  onClosed(listener: (event: HerdrTerminalClosed) => void): () => void
}

export type HerdrTerminalControlOptions = {
  cols: number
  rows: number
  takeover?: boolean
}

export type HerdrSequencedEvent = {
  sequence: number
  event: string
  data: unknown
}

export type HerdrEventSubscription = {
  release(): void
  onEvent(listener: (event: HerdrSequencedEvent) => void): () => void
  onError(listener: (error: HerdrRuntimeError) => void): () => void
}

export type HerdrHostTransport = {
  ensureSession(sessionName: string): Promise<void>
  request<T>(sessionName: string, method: string, params: unknown): Promise<HerdrResponse<T>>
  subscribeEvents?(sessionName: string, afterSequence: number): HerdrEventSubscription
  controlTerminal?(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController
}

export class HerdrRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrRuntimeError'
    this.code = code
  }
}

const REQUIRED_HERDR_CAPABILITIES = [
  'external_refs',
  'resumable_events',
  'portable_layouts',
  'terminal_control_v2',
  'terminal_history',
  'controller_takeover'
] as const

export function assertHerdrRuntimeCompatible(capabilities: HerdrServerCapabilities): void {
  if (capabilities.protocol < HERDR_MINIMUM_PROTOCOL_VERSION) {
    throw new HerdrRuntimeError(
      'herdr_incompatible',
      `Orca requires Herdr protocol ${HERDR_MINIMUM_PROTOCOL_VERSION} or newer; received ${capabilities.protocol}`
    )
  }
  const missing = REQUIRED_HERDR_CAPABILITIES.filter((name) => !capabilities[name])
  if (missing.length > 0) {
    throw new HerdrRuntimeError(
      'herdr_incompatible',
      `Herdr is missing required capabilities: ${missing.join(', ')}`
    )
  }
}

export function unwrapHerdrResponse<T>(response: HerdrResponse<T>): T {
  if ('error' in response) {
    throw new HerdrRuntimeError(response.error.code, response.error.message)
  }
  return response.result
}
