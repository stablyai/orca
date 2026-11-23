export type CodexAppServerServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type CodexAppServerConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (request: CodexAppServerServerRequest) => void
  onUnhandledFrame?: (kind: string, payload: unknown) => void
  /** Root exit, reported once; expected if close began, including after an unproven close. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
  /** No later request can run; process exit proof may still be pending. */
  onClose?: (error: Error) => void
  /** Awaited once the child has a pid and before the handshake; a rejection reaps the child. */
  onSpawned?: (pid: number) => Promise<void>
}

export type CodexAppServerConnection = {
  readonly pid: number | undefined
  /** The launcher's watcher process, when the launch reported one. */
  readonly watcherPid?: number
  readonly closed: boolean
  request: (
    method: string,
    params?: Record<string, unknown>,
    /** `timeoutMs` null: no deadline; the caller bounds the wait. */
    options?: { timeoutMs?: number | null; onReply?: (result?: unknown) => void }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
  respond: (id: number | string, result: unknown) => void
  respondWithError: (id: number | string, code: number, message: string) => void
  /** Stops provider stdout at a record boundary while a durable sink drains. */
  pauseReading?: () => void
  /** Continues with any records retained from the chunk that triggered the pause. */
  resumeReading?: () => void
  /** Resolves true only after the child emitted `exit` or `close`; false is unproven. */
  close: () => Promise<boolean>
  /** The last close's separate root and workload observations. */
  readonly closeResult?: ProviderProcessCloseResult | null
  /** The root exited, but the forced kill of its process tree could not prove the tree gone. */
  readonly processTreeUnproven?: boolean
  /** Present when the terminal daemon runs this app-server for the chat. */
  readonly relay?: {
    /** It kept running from before this app started; its thread is already loaded and live. */
    readonly reattached: boolean
    /** Lets the kept output through once the chat can route it. */
    releaseOutput: () => void
  }
}
import type { ProviderProcessCloseResult } from '../../provider-process/provider-process-close'
