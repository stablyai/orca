import { resolveOrcaSessionParty } from '../addressing/orchestration-party'
import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isNativeLocalLocation } from '../../../../shared/execution-host'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import {
  conversationRecordReader,
  clearedInto
} from '../addressing/session-lineage/structured-session-lineage'
import { structuredSessionMailReach } from '../mailbox/routing/structured-session-mail-address'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'

export async function sessionLinkCandidates(
  runtime: OrcaRuntimeService
): Promise<SessionLinkParticipant[]> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('The agent session host is not available.')
  }
  const visible = host.deps.store.getVisibleSessionTabIndex()
  if (!visible.present) {
    throw new Error('Open the agent chats before choosing a partner.')
  }
  const reader = conversationRecordReader(host.deps.store)
  const workspaces = await runtime.getWorktreePs(100)
  const result: SessionLinkParticipant[] = []
  for (const record of reader.listRecords()) {
    if (
      !isOrcaSessionId(record.sessionId) ||
      !visible.sessionIds.includes(record.sessionId) ||
      clearedInto(record) ||
      !isNativeLocalLocation(record.location) ||
      !['claude', 'codex'].includes(record.provider)
    ) {
      continue
    }
    if (
      structuredSessionMailReach(reader, record, runtime.getOrchestrationDb()).kind !== 'reachable'
    ) {
      continue
    }
    if (
      resolveOrcaSessionParty(record.sessionId, runtime.getOrchestrationDb(), reader)
        .terminalHandle !== null
    ) {
      continue
    }
    const workspace = workspaces.worktrees.find(
      (row) => row.worktreeId === record.location.workspaceId
    )
    const pane = structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(record.sessionId),
      record.sessionId
    )
    const agent = workspace?.agents.find((row) => row.paneKey === pane)
    const directory = record.launchDirectory ?? workspace?.path
    if (!directory) {
      continue
    }
    result.push(
      SessionLinkParticipant.parse({
        sessionId: record.sessionId,
        conversationId: canonicalOrcaSessionId(record.sessionId, reader),
        name: record.conversationName ?? agent?.conversationName ?? record.provider,
        agent: record.provider,
        workspaceId: record.location.workspaceId,
        directory,
        branch: workspace?.branch ?? '',
        task: (agent?.prompt ?? agent?.taskTitle ?? '').slice(0, 2048),
        context: record.providerContextBoundary?.operationId ?? '',
        role: 'implementer'
      })
    )
  }
  return result
}
