export type AcpResponse = { value: unknown } | { error: Error }

export type AcpRequestOptions<T = unknown> = {
  timeoutMs?: number | null
  /** 'cancel': a timeout asks the agent to drop the call and never touches the stream, so an
   *  unanswered control cannot end the connection. Default withdraws the write. */
  onTimeout?: 'withdraw' | 'cancel'
  settle: (response: AcpResponse) => T
}

export type AcpPendingResponse = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function readAcpResponse(
  response: AcpResponse,
  settle: AcpRequestOptions['settle'] | undefined
): unknown {
  if (settle) {
    return settle(response)
  }
  if ('error' in response) {
    throw response.error
  }
  return response.value
}
