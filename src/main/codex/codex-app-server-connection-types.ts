export type CodexAppServerServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type CodexAppServerConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (request: CodexAppServerServerRequest) => void
  onUnhandledFrame?: (kind: string, payload: unknown) => void
  onExit?: (error: Error) => void
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
  /** Resolves true only after the child emitted `exit` or `close`; false is unproven. */
  close: () => Promise<boolean>
}
