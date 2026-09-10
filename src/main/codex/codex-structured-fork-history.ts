import type { CodexSession } from './codex-structured-session-state'
import type {
  AgentSessionForkSupport,
  AgentSessionForkTarget
} from '../../shared/agent-session-fork'
import {
  assertCodexForkedIdentities,
  assertCodexForkedTurnIds
} from './codex-structured-fork-identity'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { verifyCodexRevertedHistory } from './codex-structured-rewind'

export async function verifyCodexForkedHistory(
  connection: CodexAppServerConnection,
  threadId: string,
  fork: AgentSessionForkTarget,
  timeoutMs?: number
): Promise<void> {
  const items = await verifyCodexRevertedHistory(
    { connection, threadId },
    { turnsBackwardsCursor: null, itemsBackwardsCursor: null },
    '',
    timeoutMs,
    'absent',
    (turnIds) => assertCodexForkedTurnIds(fork, turnIds)
  )
  assertCodexForkedIdentities(
    threadId,
    fork,
    items.map((item) => item.identity)
  )
}

export function codexSessionForkSupport(
  session: CodexSession | undefined
): AgentSessionForkSupport {
  return !session
    ? { supported: false, reason: 'unsupported' }
    : session.historyMode === 'legacy'
      ? { supported: false, reason: 'history-not-paginated' }
      : { supported: true }
}
