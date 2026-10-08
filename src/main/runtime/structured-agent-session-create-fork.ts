import type { AgentSessionForkOrigin } from '../../shared/agent-session-fork-origin'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import {
  agentJournalTurnForkPoint,
  readAgentJournalTurn
} from '../../shared/agent-session-turn-record'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  refuseUnclassified
} from '../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionForkSource } from '../../shared/structured-agent-session-create'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { ResolvedStructuredAgentSessionCreateSource } from './structured-agent-session-create-source'

function notForkable(): AgentSessionRefusalError {
  return new AgentSessionRefusalError(
    refuseUnclassified('agent_session_operation_invalid', 'This turn cannot be forked.')
  )
}

/** The origin a fork of `source` records, decided here and never by the client: Claude copies
 *  through whatever entry it is handed. Refuses a turn with no point the provider can cut at. */
async function resolveStructuredAgentSessionForkOrigin(input: {
  source: StructuredAgentSessionForkSource
  record: AgentSessionRecord
  item: (itemId: string) => Promise<AgentJournalRenderItem | null>
}): Promise<AgentSessionForkOrigin> {
  const { source, record } = input
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!head) {
    throw notForkable()
  }
  const row = await input.item(source.itemId)
  // A turn record is its own turn; every other row names the one it belongs to.
  const turnRow = row?.turnScope?.kind === 'turn' ? await input.item(row.turnScope.turnItemId) : row
  const turn = readAgentJournalTurn(turnRow?.body)
  const forkPoint = agentJournalTurnForkPoint(record.provider, turn)
  if (forkPoint === null) {
    throw notForkable()
  }
  return {
    sessionId: source.sessionId,
    itemId: source.itemId,
    providerSessionId: head.handle.nativeId,
    forkPoint
  }
}

function sameFork(origin: AgentSessionForkOrigin, source: StructuredAgentSessionForkSource) {
  return origin.sessionId === source.sessionId && origin.itemId === source.itemId
}

/** What a create that forks attaches with. Nothing is copied here: the new chat's first start
 *  has its provider copy the conversation, from the origin on its record. */
export async function resolveStructuredAgentSessionForkForCreate(input: {
  host: StructuredAgentSessionHost
  agent: string
  forkFrom: StructuredAgentSessionForkSource
  selfSessionId: string
  location: AgentSessionExecutionLocation
}): Promise<ResolvedStructuredAgentSessionCreateSource> {
  const { host, forkFrom } = input
  const store = host.deps.store
  // A retry of a create that already reserved its record answers from it: the parent may have
  // moved on, and the origin a fork records never changes.
  const committed = store.getRecord(input.selfSessionId)
  if (committed?.forkedFrom && sameFork(committed.forkedFrom, forkFrom)) {
    return {
      forkedFrom: committed.forkedFrom,
      accountHome: committed.accountHome,
      ...(committed.options ? { options: committed.options } : {})
    }
  }
  const parent = store.getRecord(forkFrom.sessionId)
  if (!parent) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  // A copy is its parent's agent, in its parent's workspace: nowhere else can open it.
  if (
    parent.provider !== input.agent ||
    !agentSessionExecutionLocationsEqual(parent.location, input.location)
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const launchDirectory = agentSessionPinnedLaunchDirectory(parent)
  return {
    forkedFrom: await resolveStructuredAgentSessionForkOrigin({
      source: forkFrom,
      record: parent,
      item: (itemId) => host.journalItem(forkFrom.sessionId, itemId)
    }),
    accountHome: parent.accountHome,
    ...(parent.options ? { options: parent.options } : {}),
    ...(launchDirectory ? { launchDirectory } : {})
  }
}
