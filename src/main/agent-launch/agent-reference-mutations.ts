// Owner-specific agent-reference mutation engine (terminal quick commands,
// commit-message agent choice, Source Control AI settings). Enforces the
// field-level stale-reference write rule so unrelated edits save while a proven
// stale reference is preserved, and a *changed* agent must be a currently
// effectively enabled live identity. Quick-command owner cases live in
// agent-reference-quick-command-mutations.ts.

import type { CommitMessageAiSettings, GlobalSettings, TuiAgent } from '../../shared/types'
import type { SourceControlAiSettings } from '../../shared/source-control-ai-types'
import type { AgentReferenceMutationRequest } from '../../shared/agent-reference-snapshot'
import type { AgentCatalog } from '../../shared/custom-tui-agents'
import { decideAgentField } from './agent-reference-field-decision'
import {
  applyQuickCommandDelete,
  applyQuickCommandSave,
  applyQuickCommandsReorder
} from './agent-reference-quick-command-mutations'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type AgentReferenceMutationError = {
  ok: false
  code:
    | 'reference_revision_conflict'
    | 'invalid_agent_reference'
    | 'invalid_reference_field'
    | 'agent_reference_payload_too_large'
  owner?: 'quick-command' | 'commit-message' | 'source-control-recipe'
  field?: string
  reason?: 'unknown_agent' | 'disabled_agent' | 'bounds' | 'conflict'
}

export type AgentReferenceMutationApplication =
  | {
      ok: true
      patch: Partial<GlobalSettings>
      newReferenceRevision: number
    }
  | AgentReferenceMutationError

export type ApplyAgentReferenceMutationArgs = {
  settings: GlobalSettings
  request: AgentReferenceMutationRequest
  currentReferenceRevision: number
  catalog: AgentCatalog
}

export function applyAgentReferenceMutation(
  args: ApplyAgentReferenceMutationArgs
): AgentReferenceMutationApplication {
  const { settings, request, currentReferenceRevision, catalog } = args
  if (request.expectedReferenceRevision !== currentReferenceRevision) {
    return { ok: false, code: 'reference_revision_conflict' }
  }
  const newReferenceRevision = currentReferenceRevision + 1
  const mutation = request.mutation

  switch (mutation.kind) {
    case 'quick-command-save':
      return applyQuickCommandSave(mutation, settings, catalog, newReferenceRevision)
    case 'quick-command-delete':
      return applyQuickCommandDelete(mutation.id, settings, newReferenceRevision)
    case 'quick-commands-reorder':
      return applyQuickCommandsReorder(mutation, settings, newReferenceRevision)
    case 'commit-message-update': {
      // IPC validates only the envelope; null/array changes would throw on the
      // `in` checks below instead of returning a typed error.
      if (!isRecord(mutation.changes)) {
        return {
          ok: false,
          code: 'invalid_reference_field',
          owner: 'commit-message',
          reason: 'bounds'
        }
      }
      const stored = settings.commitMessageAi
      const decision = decideAgentField({
        incoming: 'agentId' in mutation.changes ? mutation.changes.agentId : undefined,
        stored: stored?.agentId ?? null,
        catalog,
        allowCustomSentinel: true
      })
      if (!decision.ok) {
        return {
          ok: false,
          code: 'invalid_agent_reference',
          owner: 'commit-message',
          field: 'agentId',
          reason: decision.reason
        }
      }
      const next: CommitMessageAiSettings = {
        ...(stored as CommitMessageAiSettings),
        ...mutation.changes,
        agentId:
          decision.value === undefined
            ? (stored?.agentId ?? null)
            : (decision.value as CommitMessageAiSettings['agentId'])
      }
      return {
        ok: true,
        patch: { commitMessageAi: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
    case 'source-control-update': {
      // Same envelope-only IPC gap as commit-message-update: reject non-record
      // changes (and a non-record actions map, whose Object.entries would
      // otherwise iterate string indices into persisted rows) with typed errors.
      if (
        !isRecord(mutation.changes) ||
        (mutation.changes.actions !== undefined &&
          mutation.changes.actions !== null &&
          !isRecord(mutation.changes.actions))
      ) {
        return {
          ok: false,
          code: 'invalid_reference_field',
          owner: 'source-control-recipe',
          reason: 'bounds'
        }
      }
      const stored = settings.sourceControlAi
      const decision = decideAgentField({
        incoming: 'agentId' in mutation.changes ? mutation.changes.agentId : undefined,
        stored: stored?.agentId ?? null,
        catalog,
        allowCustomSentinel: true
      })
      if (!decision.ok) {
        return {
          ok: false,
          code: 'invalid_agent_reference',
          owner: 'source-control-recipe',
          field: 'agentId',
          reason: decision.reason
        }
      }
      // Per-action recipes apply the same field-level rule row by row.
      let nextActions = stored?.actions
      if (mutation.changes.actions !== undefined) {
        const incomingActions = mutation.changes.actions ?? {}
        const merged: NonNullable<SourceControlAiSettings['actions']> = {
          ...stored?.actions
        }
        for (const [actionId, incomingAction] of Object.entries(incomingActions)) {
          // A "__proto__" key would hit the setter in the keyed assignment
          // below and rewrite merged's prototype instead of storing a row.
          if (actionId === '__proto__' || actionId === 'constructor' || actionId === 'prototype') {
            continue
          }
          const storedAction = stored?.actions?.[actionId as keyof typeof merged]
          if (incomingAction === undefined) {
            continue
          }
          const storedAgent =
            storedAction && typeof storedAction === 'object' && 'agentId' in storedAction
              ? (storedAction as { agentId?: unknown }).agentId
              : undefined
          const incomingAgent =
            incomingAction && typeof incomingAction === 'object' && 'agentId' in incomingAction
              ? (incomingAction as { agentId?: unknown }).agentId
              : undefined
          const actionDecision = decideAgentField({
            incoming: incomingAgent,
            stored: storedAgent ?? null,
            catalog,
            allowCustomSentinel: true
          })
          if (!actionDecision.ok) {
            return {
              ok: false,
              code: 'invalid_agent_reference',
              owner: 'source-control-recipe',
              field: actionId,
              reason: actionDecision.reason
            }
          }
          merged[actionId as keyof typeof merged] = {
            ...(storedAction as object),
            ...(incomingAction as object),
            agentId:
              actionDecision.value === undefined
                ? ((storedAgent ?? null) as TuiAgent | 'custom' | null)
                : (actionDecision.value as TuiAgent | 'custom' | null)
          } as NonNullable<SourceControlAiSettings['actions']>[keyof typeof merged]
        }
        nextActions = merged
      }
      const next: SourceControlAiSettings = {
        ...(stored as SourceControlAiSettings),
        ...mutation.changes,
        agentId:
          decision.value === undefined
            ? (stored?.agentId ?? null)
            : (decision.value as SourceControlAiSettings['agentId']),
        ...(nextActions !== undefined ? { actions: nextActions } : {})
      }
      return {
        ok: true,
        patch: { sourceControlAi: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
  }
}
