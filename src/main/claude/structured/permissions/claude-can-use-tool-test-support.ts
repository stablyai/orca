import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { FakeConnection } from '../claude-structured-session-test-support'

type CanUseToolOptions = Parameters<CanUseTool>[2]

export function invokeCanUseTool(
  connection: FakeConnection,
  toolName: string,
  requestId: string,
  toolUseID: string,
  extra: {
    input?: Record<string, unknown>
    suggestions?: CanUseToolOptions['suggestions']
    signal?: AbortSignal
    agentID?: string
    decisionReason?: string
  } = {}
): { promise: Promise<unknown>; settled: () => boolean } {
  const asked: CanUseToolOptions = {
    requestId,
    toolUseID,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.suggestions ? { suggestions: extra.suggestions } : {}),
    ...(extra.decisionReason ? { decisionReason: extra.decisionReason } : {}),
    ...(extra.agentID ? { agentID: extra.agentID } : {})
  }
  let done = false
  const promise = Promise.resolve(
    connection.handlers.canUseTool?.(toolName, extra.input ?? {}, asked)
  ).finally(() => {
    done = true
  })
  return { promise, settled: () => done }
}
