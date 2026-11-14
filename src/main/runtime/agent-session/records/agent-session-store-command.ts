import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionOperationClaim,
  AgentSessionOperationDecision
} from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { newChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  commitAgentSessionReservation,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from '../ownership/agent-session-reservation-admission'
import {
  admitAgentSessionOperationInto,
  admitAgentSessionGlobalOperationInto,
  admitAgentSessionMutationOperation,
  admitAndClaimAgentSessionOperationInto,
  claimAgentSessionOperationInto,
  type AgentSessionMutationOperationAdmission,
  type AgentSessionMutationOperationDecision,
  type AgentSessionOperationAdmission
} from '../ownership/agent-session-operation-admission'
import {
  applyAgentSessionRestartProbes,
  type AgentSessionRestartProbe
} from '../ownership/agent-session-restart-reconciliation'
import {
  renewAgentSessionLeases,
  type AgentSessionLeaseRenewal
} from '../ownership/agent-session-lease-renewal'
import {
  settleFailedAgentSessionAcquisition,
  settleFailedAgentSessionPostAcquisitionAttachment,
  type AgentSessionFailedAcquisitionSettlement
} from '../agent-session-acquisition-failure-settlement'
import {
  initializeAgentSessionTabs,
  effectiveAgentSessionTabs,
  setAgentSessionTabVisibility,
  showAgentSessionTabs
} from '../agent-session-tab-table'
import { commitAgentSessionFounding } from './agent-session-founding-admission'
import type { AgentSessionStoreState } from './agent-session-store-state'

export type AgentSessionStoreCommand =
  | {
      kind: 'reserve' | 'found'
      request: Omit<AgentSessionReserveRequest, 'spawnToken'> & { spawnToken: string }
      leaseTtlMs: number
      legacyTabIds: readonly string[]
      refuseReplay?: boolean
    }
  | { kind: 'failed-acquisition'; args: AgentSessionFailedAcquisitionSettlement; attached: boolean }
  | { kind: 'renew'; renewals: readonly AgentSessionLeaseRenewal[]; leaseTtlMs: number }
  | { kind: 'restart'; probes: ReadonlyMap<string, AgentSessionRestartProbe>; now: number }
  | { kind: 'admit' | 'global-admit' | 'admit-launch'; args: AgentSessionOperationAdmission }
  | { kind: 'admit-mutation'; args: AgentSessionMutationOperationAdmission }
  | { kind: 'claim'; args: { callerKey: string; operationId: string } }
  | { kind: 'tabs-initialize'; legacyTabIds: readonly string[] }
  | { kind: 'tabs-show'; sessionIds: readonly string[]; legacyTabIds: readonly string[] }
  | {
      kind: 'tab-visibility'
      sessionId: string
      visible: boolean
      tabId?: string
      legacyTabIds: readonly string[]
    }
  | { kind: 'permission-backfill'; fullAccess: ReadonlyMap<string, boolean> }

export type AgentSessionStoreCommandResult<C extends AgentSessionStoreCommand> = C extends {
  kind: 'reserve' | 'found'
}
  ? AgentSessionReserveResult
  : C extends { kind: 'failed-acquisition' }
    ? AgentSessionRecord
    : C extends { kind: 'renew' }
      ? AgentSessionRecord[]
      : C extends { kind: 'restart' }
        ? Map<string, AgentSessionRecord>
        : C extends { kind: 'admit' | 'global-admit' }
          ? AgentSessionOperationDecision
          : C extends { kind: 'admit-launch' }
            ? { decision: AgentSessionOperationDecision; claim: AgentSessionOperationClaim | null }
            : C extends { kind: 'admit-mutation' }
              ? AgentSessionMutationOperationDecision
              : C extends { kind: 'claim' }
                ? AgentSessionOperationClaim
                : C extends { kind: 'tab-visibility' }
                  ? string | null
                  : void

export function agentSessionStoreCommandSelection(command: AgentSessionStoreCommand): {
  recordIds: string[]
  operation?: { callerKey: string; operationId: string }
  adoptedNativeId?: string
  legacyRecordIds?: readonly string[]
  missingPermission?: boolean
  allCallers?: boolean
  tabs?: boolean
  pruneAt?: number
} {
  switch (command.kind) {
    case 'reserve':
    case 'found':
      return {
        recordIds: [command.request.sessionId],
        operation: command.request.operation,
        adoptedNativeId: command.request.adoptedHandleLink?.handle.nativeId,
        legacyRecordIds: command.legacyTabIds,
        tabs: true,
        pruneAt: command.request.now
      }
    case 'failed-acquisition':
      return { recordIds: [command.args.sessionId], operation: command.args }
    case 'renew':
      return { recordIds: command.renewals.map((renewal) => renewal.sessionId) }
    case 'restart':
      return { recordIds: [...command.probes.keys()], pruneAt: command.now }
    case 'admit':
    case 'global-admit':
    case 'admit-launch':
    case 'claim':
      return {
        recordIds: [],
        operation: command.args,
        allCallers: command.kind === 'global-admit',
        ...('now' in command.args ? { pruneAt: command.args.now } : {})
      }
    case 'admit-mutation':
      return {
        recordIds: [command.args.envelope.sessionId],
        operation: {
          callerKey: command.args.callerKey,
          operationId: command.args.envelope.clientOperationId
        },
        allCallers: command.args.operationIdScope === 'global',
        pruneAt: command.args.now
      }
    case 'tabs-initialize':
      return { recordIds: [], legacyRecordIds: command.legacyTabIds, tabs: true }
    case 'tabs-show':
      return {
        recordIds: [...command.sessionIds],
        legacyRecordIds: command.legacyTabIds,
        tabs: true
      }
    case 'tab-visibility':
      return { recordIds: [command.sessionId], legacyRecordIds: command.legacyTabIds, tabs: true }
    case 'permission-backfill':
      return { recordIds: [], missingPermission: true }
  }
}

export function applyAgentSessionStoreCommand(
  state: AgentSessionStoreState,
  command: AgentSessionStoreCommand
): unknown {
  switch (command.kind) {
    case 'reserve':
      return commitAgentSessionReservation(
        state,
        command.request,
        command.leaseTtlMs,
        command.legacyTabIds
      )
    case 'found': {
      const result = commitAgentSessionFounding(state, command.request, command.legacyTabIds)
      if (command.refuseReplay && result.disposition === 'replayed') {
        throw agentSessionRefusalError('agent_session_operation_unknown', {
          reason: 'outcomeUnknown'
        })
      }
      return result
    }
    case 'failed-acquisition':
      return command.attached
        ? settleFailedAgentSessionPostAcquisitionAttachment(state, command.args)
        : settleFailedAgentSessionAcquisition(state, command.args)
    case 'renew':
      return renewAgentSessionLeases(state, command.renewals, command.leaseTtlMs)
    case 'restart':
      return applyAgentSessionRestartProbes(state, command.probes, command.now)
    case 'admit':
      return admitAgentSessionOperationInto(state, command.args)
    case 'global-admit':
      return admitAgentSessionGlobalOperationInto(state, command.args)
    case 'admit-launch':
      return admitAndClaimAgentSessionOperationInto(
        state,
        command.args,
        (decision) =>
          decision.decision === 'admit' ||
          (decision.decision === 'replay' && decision.row.outcome.status === 'pending')
      )
    case 'admit-mutation':
      return admitAgentSessionMutationOperation(state, command.args)
    case 'claim':
      return claimAgentSessionOperationInto(state, command.args)
    case 'tabs-initialize':
      return initializeAgentSessionTabs(state, command.legacyTabIds)
    case 'tabs-show':
      return showAgentSessionTabs(state, command.sessionIds, command.legacyTabIds)
    case 'tab-visibility': {
      const retired =
        effectiveAgentSessionTabs(state, command.legacyTabIds).tabIdFor(command.sessionId) ?? null
      setAgentSessionTabVisibility(
        state,
        command.sessionId,
        command.visible,
        command.tabId,
        command.legacyTabIds
      )
      return command.visible ? (state.sessionTabs?.tabIdFor(command.sessionId) ?? null) : retired
    }
    case 'permission-backfill':
      for (const [id, record] of state.records) {
        if (record.permissionMode !== undefined) {
          continue
        }
        const { permissionMode: saved, ...options } = record.options ?? {}
        const permissionMode =
          saved ??
          newChatPermissionMode(
            record.provider,
            command.fullAccess.get(record.provider) ? 'full-access' : 'ask'
          )
        if (permissionMode) {
          state.records.set(id, {
            ...record,
            ...(saved !== undefined ? { options } : {}),
            permissionMode
          })
        }
      }
      return undefined
  }
}
