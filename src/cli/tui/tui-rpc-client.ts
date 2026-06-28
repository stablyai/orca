/** Minimal RPC surface the TUI data sources need. RuntimeClient satisfies this
 *  structurally, and tests provide a lightweight fake without casting through
 *  the full client. */
export type TuiRpcClient = {
  call<T>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{ result: T }>
}
