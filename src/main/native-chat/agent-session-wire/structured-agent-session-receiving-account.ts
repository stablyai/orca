import {
  acquiredAgentSessionAccount,
  type ClaudeAccountRecipe
} from '../../../shared/agent-session-acquired-account'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { NativeResponseEvidence } from '../../runtime/orchestration/structured-parent-account-work'
import { StructuredNativeResponses } from './structured-agent-session-native-responses'

const responses = new WeakMap<
  StructuredAgentSessionHostSession['journal'],
  StructuredNativeResponses
>()

/** Account construction authority is independent of whether an existing child may be retired. */
export async function structuredAgentSessionReceivingAccount(
  deps: StructuredAgentSessionHostDeps,
  record: AgentSessionRecord,
  session: StructuredAgentSessionHostSession | undefined,
  next?: AgentJournalSubmission,
  purpose?: 'read' | 'identity'
): Promise<{ home: AgentSessionAccountHome | null; recipe?: ClaudeAccountRecipe }> {
  const selected = () => deps.launchAccountHome?.(record, purpose) ?? Promise.resolve(null)
  if (record.provider !== 'claude' || !deps.launchAccountHome) {
    return { home: await selected() }
  }
  let index = session && responses.get(session.journal)
  if (session && !index) {
    index = new StructuredNativeResponses()
    responses.set(session.journal, index)
  }
  const evidence: NativeResponseEvidence =
    session && index
      ? index.read(session.journal, record.lease.runtimeFence)
      : { pending: [], disposed: new Set() }
  const lineage = deps.store.lineageRecords(record)
  const recorded = acquiredAgentSessionAccount(record, deps.store.hostId)
  // Historical clear links identify native work; they cannot prove a successor's acquired account.
  const observation =
    recorded &&
    (!session?.child ||
      (recorded.fence === session.child.fence && recorded.generation === session.child.generation))
      ? recorded
      : null
  const fence = session?.child?.fence ?? observation?.fence
  if (fence !== undefined && index?.signedOut(fence)) {
    return { home: await selected() }
  }
  const body =
    next && session
      ? session.journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
      : null
  const mail = body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice'
  if (
    !mail &&
    session &&
    next?.origin === 'client' &&
    index?.recovery.allows(session.journal, next)
  ) {
    return { home: await selected() }
  }
  const native =
    deps.parentAccountWork?.(record, lineage[0].sessionId, evidence, {
      getRecord: deps.store.getConversation,
      listRecords: () => lineage.map(agentSessionConversationView),
      getVisibleSessionTabIndex: deps.store.getVisibleSessionTabIndex
    }) ?? false
  if (mail || native) {
    const home =
      session?.child?.accountHome ??
      (observation ? { variable: 'CLAUDE_CONFIG_DIR', path: observation.recipe.home } : null)
    if (home) {
      return { home, ...(observation ? { recipe: observation.recipe } : {}) }
    }
  }
  // No successful observation exists for a gone historical process: use the selected route truthfully.
  return { home: await selected() }
}
