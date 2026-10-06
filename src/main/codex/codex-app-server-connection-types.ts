export type CodexAppServerServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type CodexAppServerConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (request: CodexAppServerServerRequest) => void
  onUnhandledFrame?: (kind: string, payload: unknown) => void
  /** The root process exited, reported once. `expected`: a close had begun, so it is that close's
   *  end, even one that gave up first and came back unproven. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
  /** Awaited once the child has a pid and before the handshake; a rejection reaps the child. */
  onSpawned?: (pid: number) => Promise<void>
}

export type CodexAppServerConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
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
  /** The root exited, but the forced kill of its process tree could not prove the tree gone. */
  readonly processTreeUnproven?: boolean
  /** The last close's kill reached the app-server itself and its exit has not been seen: it
   *  cannot write again, so its thread may be resumed elsewhere. */
  readonly providerKilled?: boolean
}
