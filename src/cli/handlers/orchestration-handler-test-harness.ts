import { vi } from 'vitest'
import { RuntimeClientError } from '../runtime-client'

// Why: shared mock/stub harness for the orchestration CLI handler spec, split
// out so the spec file stays under the max-lines budget. The spec's vi.mock
// factories reference these mocks, so this module must not import
// './orchestration' (it would load the mocked modules before these bindings
// initialize).

export const callMock = vi.fn()
export const getTerminalHandleMock = vi.fn()

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

export function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

export function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

// Queues the stale-handle remint chain shared by coordinator commands:
// stale terminal.show → resolvePane returns liveHandle → downstream RPC result.
export function stubStaleHandleRemint(liveHandle: string, downstream: unknown): void {
  callMock
    .mockRejectedValueOnce(staleHandleError())
    .mockResolvedValueOnce({ result: { terminal: { handle: liveHandle } } })
    .mockResolvedValueOnce(downstream)
}

// Queues a stale terminal.show followed by a resolvePane remint that fails with `error`.
export function stubStaleHandleRemintFailure(error: RuntimeClientError): void {
  callMock.mockRejectedValueOnce(staleHandleError()).mockRejectedValueOnce(error)
}

// afterEach: restore the terminal-identity env vars a test mutated.
export function restoreTerminalIdentityEnv(): void {
  getTerminalHandleMock.mockReset()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
}

export type CliFlagMap = Map<string, string | boolean>

// Builds the standard handler invocation the whole spec shares: json mode,
// fixed cwd, and the callMock-backed client.
export function handlerInvoker(
  handler: (ctx: never) => unknown
): (flags: CliFlagMap) => Promise<unknown> {
  return (flags) =>
    Promise.resolve(
      handler({ flags, client: { call: callMock }, cwd: '/tmp/repo', json: true } as never)
    )
}
