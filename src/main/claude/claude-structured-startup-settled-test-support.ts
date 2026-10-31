import { createClaudeQueryOperation } from './claude-query-operation'
import type { FakeConnection } from './claude-structured-session-test-contract'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

const opened = new WeakMap<
  ClaudeStructuredSessionAdapter,
  Map<string, Promise<StructuredAgentSessionProviderOpenResult>>
>()

/** Direct adapter fixtures explicitly join the host-owned open after acquire. */
export function claudeOpened(
  adapter: ClaudeStructuredSessionAdapter,
  sessionId: string
): Promise<StructuredAgentSessionProviderOpenResult> {
  let sessions = opened.get(adapter)
  if (!sessions) {
    sessions = new Map()
    opened.set(adapter, sessions)
  }
  const session = adapter['sessions'].get(sessionId)
  if (!session) {
    return Promise.reject(new Error(`no Claude session for ${sessionId}`))
  }
  const key = `${sessionId}:${session.acquisitionGeneration}`
  const previous = sessions.get(key)
  if (previous) {
    return previous
  }
  const current = adapter.open({
    sessionId,
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    signal: new AbortController().signal
  })
  sessions.set(key, current)
  return current
}

export async function claudeStartupSettled(
  adapter: ClaudeStructuredSessionAdapter,
  sessionId: string
): Promise<void> {
  await claudeOpened(adapter, sessionId)
}

export function ownFakeClaudeQuery(
  connection: FakeConnection,
  account?: AgentSessionAccountKind
): void {
  const operation = createClaudeQueryOperation(account)
  operation.start({ initializationResult: connection.initializationResult })
  connection.initializationResult = () => operation.result
  Object.defineProperty(connection, 'startupFailure', { get: () => operation.failure })
  connection.startupSettled = () =>
    operation.result.then(
      () => {},
      () => {}
    )
  connection.rejectStartup = operation.reject
}
