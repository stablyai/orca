import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { getConnectionExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import { isLocalHookConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  allLinks,
  findLink,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { ConversationKey } from './external-conversation-types'

export type SessionRows = Pick<OrcaRuntimeService, 'getAgentStatusRowsForPane'>

type CapturedSession = Required<Pick<ExternalConversationLink, 'providerSession' | 'captureHostId'>>

export function hookReportedSession(
  rows: SessionRows,
  link: Pick<ExternalConversationLink, 'paneKey' | 'agent'>
): CapturedSession | null {
  let freshest: { row: AgentStatusIpcPayload; session: AgentProviderSessionMetadata } | null = null
  for (const row of rows.getAgentStatusRowsForPane(link.paneKey)) {
    const session = normalizeAgentProviderSession(row.providerSession)
    if (
      session &&
      row.agentType === link.agent &&
      !row.structuredHost &&
      (!freshest || row.receivedAt > freshest.row.receivedAt)
    ) {
      freshest = { row, session }
    }
  }
  if (!freshest) {
    return null
  }
  // WSL relay tags are local transport; only SSH connection IDs identify remote hosts.
  const { connectionId } = freshest.row
  const captureHostId: ExecutionHostId = getConnectionExecutionHostId(
    isLocalHookConnectionId(connectionId) ? null : connectionId
  )
  return { providerSession: freshest.session, captureHostId }
}

/** Persist sessions before pane closure removes hook rows, so linked conversations can reopen. */
export class LinkedSessionCapture {
  private readonly watched = new Map<string, { key: ConversationKey; sessionId?: string }>()

  constructor(
    private readonly store: ExternalConversationLinkStore,
    private readonly rows: SessionRows
  ) {}

  // Watch restored links before their sessions move, even if no send occurs.
  restore(): void {
    for (const { link } of allLinks(this.store)) {
      this.capture(link, link.paneKey)
    }
  }

  sessionsChanged(sessions: readonly { paneKey: string; sessionId: string }[]): void {
    for (const { paneKey, sessionId } of sessions) {
      const watch = this.watched.get(paneKey)
      if (watch && watch.sessionId !== sessionId) {
        this.capture(watch.key, paneKey)
      }
    }
  }

  capture(key: ConversationKey, paneKey: string): LinkedConversation | null {
    const linked = findLink(this.store, key)
    if (!linked || linked.link.paneKey !== paneKey) {
      this.watched.delete(paneKey)
      return linked
    }
    const captured = hookReportedSession(this.rows, linked.link)
    this.watched.set(paneKey, {
      key: { source: key.source, externalId: key.externalId },
      sessionId: (captured ?? linked.link).providerSession?.id
    })
    if (
      !captured ||
      (linked.link.captureHostId === captured.captureHostId &&
        agentProviderSessionsEqual(
          linked.link.agent,
          linked.link.providerSession,
          captured.providerSession
        ))
    ) {
      return linked
    }
    const link = { ...linked.link, ...captured }
    try {
      writeLink(this.store, linked.workspace, link)
    } catch (error) {
      console.warn('[connectors] the agent session was not saved on its conversation link', error)
      return linked
    }
    return { ...linked, link }
  }
}
