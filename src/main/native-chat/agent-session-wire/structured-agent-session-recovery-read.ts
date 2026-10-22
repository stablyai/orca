import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat-usage-limit-cut'
import {
  structuredSessionRecoveryOptions,
  type RecoveryContextCache
} from '../../runtime/structured-session-recovery-options'
import { withoutInheritedClaudeConfigDir } from '../../claude/claude-config-dir-pin'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

type RecoverySession = { journal: Pick<StructuredAgentSessionHostSession['journal'], 'snapshot'> }
type RecoveryDeps = Pick<
  StructuredAgentSessionHostDeps,
  'resolveLaunchEnv' | 'resolveWorkspacePath'
> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}
const contexts = new WeakMap<RecoverySession, RecoveryContextCache>()

function recoveryIdentity(session: RecoverySession, deps: RecoveryDeps, sessionId: string) {
  const snapshot = session.journal.snapshot()
  const cut = latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions)
  const record = deps.store.getRecord(sessionId)
  return cut && record
    ? JSON.stringify([
        snapshot.cursor,
        cut.turnItemId,
        record.provider,
        record.providerHandleChain,
        record.accountHome,
        record.launchDirectory,
        record.lease.runtimeFence
      ])
    : null
}

/** Outside send serialization, with admission from the complete journal before any locator I/O. */
export async function readStructuredSessionRecovery(
  session: RecoverySession,
  context: { deps: RecoveryDeps; conversation: (id: string) => Promise<RecoverySession> },
  sessionId: string
) {
  try {
    const deps = context.deps
    const key = recoveryIdentity(session, deps, sessionId)
    if (!key) {
      contexts.delete(session)
      return { canSwitchAccount: false }
    }
    let cache = contexts.get(session)
    if (!cache) {
      cache = {}
      contexts.set(session, cache)
    }
    const record = deps.store.getRecord(sessionId)
    if (!record) {
      return { canSwitchAccount: false }
    }
    const overlay = await deps.resolveLaunchEnv?.(record.provider)
    const launchEnv = {
      ...(record.provider === 'claude'
        ? withoutInheritedClaudeConfigDir(process.env)
        : process.env),
      ...overlay
    }
    const result = await structuredSessionRecoveryOptions(record, launchEnv, {
      cache,
      resolveWorkspacePath: deps.resolveWorkspacePath
    })
    const current = await context.conversation(sessionId)
    return current === session && key === recoveryIdentity(session, deps, sessionId)
      ? result
      : { canSwitchAccount: false }
  } catch (error: unknown) {
    console.warn('Could not read chat recovery choices', error)
    return { canSwitchAccount: false }
  }
}
