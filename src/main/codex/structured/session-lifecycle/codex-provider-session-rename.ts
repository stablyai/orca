import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  runCodexAppServerSession,
  type CodexAppServerRpc
} from '../../app-server/codex-app-server-session'
import { isNativeLocalLocation as supportsCodexStructuredLocation } from '../../../../shared/execution-host'
import { agentDrivesSession } from '../../../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { CODEX_STRUCTURED_AGENT } from '../launch/codex-structured-agent-definition'
import {
  codexProviderSessionInvocation,
  type CodexProviderSessionInvocationDeps
} from './codex-provider-session-invocation'
import type { CodexSession } from './codex-structured-session-state'

export type CodexRenameInvocationDeps = CodexProviderSessionInvocationDeps

const RENAME_TIMEOUT_MS = 15_000
// Older Codex refuses a name until the thread's first record reaches disk; give a fresh
// conversation two short chances, then leave the name for the user's next rename.
const EMPTY_ROLLOUT = /\brollout at .+ is empty\b/i
const EMPTY_ROLLOUT_RETRY_DELAYS_MS = [50, 200] as const

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function setThreadName(
  request: CodexAppServerRpc['request'],
  threadId: string,
  name: string
): Promise<void> {
  for (const delay of EMPTY_ROLLOUT_RETRY_DELAYS_MS) {
    try {
      await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
      return
    } catch (error) {
      if (!(error instanceof Error) || !EMPTY_ROLLOUT.test(error.message)) {
        throw error
      }
      await wait(delay)
    }
  }
  await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
}

/** Codex's own /rename is `thread/name/set`. It names an unloaded thread straight in the
 *  account's thread store, so a chat at rest takes it from a short-lived app-server without
 *  resuming the thread. */
export async function renameCodexProviderSession(input: {
  session: CodexSession | undefined
  record: AgentSessionRecord
  providerSessionId: string
  name: string
  invocation?: CodexRenameInvocationDeps
}): Promise<void> {
  const { session, providerSessionId, name } = input
  const live = session && !session.ended && !session.connection.closed ? session : null
  if (live?.threadId === providerSessionId) {
    await setThreadName(
      (method, params, options) => live.connection.request(method, params, options),
      providerSessionId,
      name
    )
    return
  }
  const { record, invocation } = input
  if (
    record.provider !== 'codex' ||
    !supportsCodexStructuredLocation(record.location) ||
    !agentDrivesSession({ definition: () => CODEX_STRUCTURED_AGENT }, record)
  ) {
    throw new Error('unsupported Codex rename location, account or handles')
  }
  if (!invocation) {
    throw new Error('Codex rename invocation is not configured')
  }
  await runCodexAppServerSession(
    await codexProviderSessionInvocation(record, invocation, RENAME_TIMEOUT_MS),
    (rpc) => setThreadName(rpc.request, providerSessionId, name)
  )
}
