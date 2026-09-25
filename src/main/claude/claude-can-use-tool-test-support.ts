// Drives the SDK's permission callback on a fake connection, the way the CLI raises a request.

import type { ClaudeStreamJsonConnectionHandlers } from './claude-stream-json-connection'
import type { FakeConnection } from './claude-structured-session-test-support'

export function invokeCanUseTool(
  connection: FakeConnection,
  toolName: string,
  requestId: string,
  toolUseID: string,
  extra: {
    input?: Record<string, unknown>
    suggestions?: unknown[]
    signal?: AbortSignal
    agentID?: string
  } = {}
): { promise: Promise<unknown>; settled: () => boolean } {
  const options = {
    requestId,
    toolUseID,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.suggestions ? { suggestions: extra.suggestions } : {})
  } as unknown as Parameters<NonNullable<ClaudeStreamJsonConnectionHandlers['canUseTool']>>[2]
  const asked = extra.agentID ? { ...options, agentID: extra.agentID } : options
  let done = false
  const promise = Promise.resolve(
    connection.handlers.canUseTool?.(toolName, extra.input ?? {}, asked)
  ).finally(() => {
    done = true
  })
  return { promise, settled: () => done }
}
