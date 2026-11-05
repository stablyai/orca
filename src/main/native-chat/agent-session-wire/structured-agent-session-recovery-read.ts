import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import { latestNativeChatUsageLimitCutSteps } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  structuredSessionRecoveryOptions,
  type RecoveryContextCache
} from '../../runtime/structured-session-recovery-options'
import { withoutInheritedClaudeConfigDir } from '../../claude/claude-config-dir-pin'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

type RecoverySession = {
  journal: Pick<StructuredAgentSessionHostSession['journal'], 'statusRead' | 'cursor'> &
    Partial<Pick<StructuredAgentSessionHostSession['journal'], 'statusReadSteps' | 'readInOrder'>>
}
type RecoveryDeps = Pick<
  StructuredAgentSessionHostDeps,
  'resolveLaunchEnv' | 'resolveWorkspacePath'
> & {
  store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
}
const contexts = new WeakMap<RecoverySession, RecoveryContextCache>()

async function recoveryIdentity(session: RecoverySession, deps: RecoveryDeps, sessionId: string) {
  const read = async () => {
    const snapshot = session.journal.statusReadSteps
      ? await finishJournalStepsAsync(session.journal.statusReadSteps())
      : session.journal.statusRead()
    return finishJournalStepsAsync(
      latestNativeChatUsageLimitCutSteps(snapshot.items, snapshot.submissions)
    )
  }
  const cut = session.journal.readInOrder ? await session.journal.readInOrder(read) : await read()
  const record = deps.store.getRecord(sessionId)
  return cut && record
    ? JSON.stringify([
        session.journal.cursor(),
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
    const key = await recoveryIdentity(session, deps, sessionId)
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
    return current === session && key === (await recoveryIdentity(session, deps, sessionId))
      ? result
      : { canSwitchAccount: false }
  } catch (error: unknown) {
    console.warn('Could not read chat recovery choices', error)
    return { canSwitchAccount: false }
  }
}
