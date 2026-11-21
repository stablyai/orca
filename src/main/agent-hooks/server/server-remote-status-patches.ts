import { normalizeAntigravityModel } from '../../../shared/agent-hook-listener/providers/antigravity/antigravity-root-model'
import {
  isSameAgentProcess,
  readAgentProcessPresence
} from '../../../shared/agent-status/process/agent-process-presence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  RemoteAgentStatusEnvelope,
  RemoteEnvelopeFields
} from './server-remote-envelope-normalization'
import type { EnrichedAgentHookEventPayload } from './server-types'

import { AgentHookServerIngestStructuredChildren } from './server-ingest-structured-children'

export abstract class AgentHookServerRemoteStatusPatches extends AgentHookServerIngestStructuredChildren {
  protected applyRelayStatusUnavailable(
    paneKey: string,
    connectionId: string | null,
    { source, worktreeId }: RemoteEnvelopeFields,
    launchToken: string | undefined
  ): void {
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    if (
      (source === 'opencode' || source === 'opencode2') &&
      connectionId !== null &&
      previous?.connectionId === connectionId &&
      previous.worktreeId === worktreeId &&
      previous.source === source &&
      previous.launchToken === launchToken &&
      this.getAgentStatusDisposition(paneKey) !== 'suppress'
    ) {
      this.clearPaneState(paneKey, { statusUnavailable: true })
    }
  }

  protected applyRelayedModel(
    paneKey: string,
    connectionId: string | null,
    envelope: RemoteAgentStatusEnvelope,
    fields: RemoteEnvelopeFields,
    payload: ParsedAgentStatusPayload
  ): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main legacy rows are enriched at admission.
    const row = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!row) {
      return
    }
    const model = readRelayedAntigravityModel(row, connectionId, envelope, fields, payload)
    if (model) {
      this.applyAntigravityModel(row, model)
    }
  }
}

function readRelayedAntigravityModel(
  row: EnrichedAgentHookEventPayload,
  connectionId: string | null,
  envelope: RemoteAgentStatusEnvelope,
  fields: Pick<RemoteEnvelopeFields, 'source' | 'worktreeId' | 'providerSession'>,
  payload: ParsedAgentStatusPayload
): string | undefined {
  const sender = readAgentProcessPresence(envelope.agentPresence)
  const owner = row.agentPresence
  if (
    fields.source !== 'antigravity' ||
    payload.agentType !== fields.source ||
    row.payload.agentType !== fields.source ||
    connectionId === null ||
    row.connectionId !== connectionId ||
    row.worktreeId !== fields.worktreeId ||
    row.launchToken !== envelope.launchToken ||
    !fields.providerSession ||
    fields.providerSession.id !== row.providerSession?.id ||
    (owner?.process && (!sender?.process || !isSameAgentProcess(owner.process, sender.process))) ||
    owner?.ended ||
    row.providerSessionOnly ||
    row.paneSleep ||
    row.payload.state === 'done' ||
    row.payload.prompt !== payload.prompt
  ) {
    return undefined
  }
  return normalizeAntigravityModel(payload.model)
}
