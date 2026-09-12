import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  agentStatusSubjectFromLegacyPane,
  parseAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'
import type { AgentHookAuthorityEvidence, EnrichedAgentHookEventPayload } from './server-types'

type StatusEntries = ReadonlyMap<string, AgentHookEventPayload>

export function resolveStatusSubject(payload: AgentHookEventPayload): AgentStatusSubject {
  const parsed = parseAgentStatusSubject(payload.subject)
  if (parsed && (parsed.kind !== 'pty' || parsed.paneKey === payload.paneKey)) {
    return parsed
  }
  return agentStatusSubjectFromLegacyPane({
    paneKey: payload.paneKey,
    worktreeId: payload.worktreeId,
    connectionId: payload.connectionId
  })
}

export function findStatusEntriesForPaneKey(
  entries: StatusEntries,
  paneKey: string
): EnrichedAgentHookEventPayload[] {
  return Array.from(entries.values()).filter(
    (entry) => (entry as EnrichedAgentHookEventPayload).paneKey === paneKey
  ) as EnrichedAgentHookEventPayload[]
}

export function findStatusKeysForPaneKey(entries: StatusEntries, paneKey: string): string[] {
  return Array.from(entries.entries()).flatMap(([statusKey, entry]) =>
    entry.paneKey === paneKey ? [statusKey] : []
  )
}

export function findStatusKeysForPaneKeys(
  entries: StatusEntries,
  commitments: ReadonlyMap<string, AgentHookAuthorityEvidence>,
  paneKeys: ReadonlySet<string>
): Set<string> {
  const statusKeys = new Set<string>()
  for (const paneKey of paneKeys) {
    for (const statusKey of findStatusKeysForPaneKey(entries, paneKey)) {
      statusKeys.add(statusKey)
    }
  }
  for (const [statusKey, evidence] of commitments) {
    if (paneKeys.has(evidence.paneKey)) {
      statusKeys.add(statusKey)
    }
  }
  return statusKeys
}

export function findLatestStatusEntryForPaneKey(
  entries: StatusEntries,
  paneKey: string
): EnrichedAgentHookEventPayload | undefined {
  return findStatusEntriesForPaneKey(entries, paneKey).sort(
    (left, right) => right.receivedAt - left.receivedAt
  )[0]
}

export function findHydratedLaunchTokenHashForPaneKey(
  commitments: ReadonlyMap<string, AgentHookAuthorityEvidence>,
  paneKey: string,
  resolvePaneKeyAlias: (paneKey: string) => string
): string | undefined {
  const resolvedPaneKey = resolvePaneKeyAlias(paneKey)
  const matches = Array.from(commitments.values()).filter(
    (evidence) => resolvePaneKeyAlias(evidence.paneKey) === resolvedPaneKey
  )
  return matches.length === 1 ? matches[0]!.launchTokenHash : undefined
}
