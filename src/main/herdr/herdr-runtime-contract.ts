import type { HerdrExternalRef } from '../../shared/herdr-session-identity'

export const HERDR_PROTOCOL_VERSION = 18

export type HerdrWorkspace = {
  workspace_id: string
  external_ref?: HerdrExternalRef
}

export type HerdrTab = {
  tab_id: string
  workspace_id: string
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

export interface HerdrTerminalController {
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

export interface HerdrEventSubscription {
  release(): void
  onEvent(listener: (event: HerdrSequencedEvent) => void): () => void
  onError(listener: (error: HerdrRuntimeError) => void): () => void
}

export interface HerdrHostTransport {
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

export function unwrapHerdrResponse<T>(response: HerdrResponse<T>): T {
  if ('error' in response) {
    throw new HerdrRuntimeError(response.error.code, response.error.message)
  }
  return response.result
}
