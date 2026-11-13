import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionOptionsReplacement } from '../../../../shared/agent-session/options/agent-session-options-replacement'
import { withAcquiredAgentSessionAccount } from '../../../../shared/agent-session/lifecycle/agent-session-acquired-account'
import {
  cancelAgentSessionUsageLimitContinue,
  type UsageLimitContinueIdentity
} from '../../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionLastTurn } from '../../../../shared/agent-session/lifecycle/agent-session-last-turn'
import type { createAgentSessionOwnerProof } from '../ownership/agent-session-owner-proof'
import { recordAgentSessionAcquisitionExit } from '../agent-session-acquisition-exit-transition'
import {
  commitAgentSessionProcessIdentity,
  evictAgentSessionOwner,
  proveAgentSessionOwner,
  releaseUnprovenAgentSessionOwner
} from '../ownership/agent-session-lease-transitions'
import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionProviderResumePoint
} from '../ownership/agent-session-provider-handle-transition'
import { releaseAgentSessionOwnerAfterSurfaceClose } from '../ownership/agent-session-surface-release-transition'
import { pinAgentSessionRecordLaunchDirectory } from './agent-session-record-launch-directory'
import {
  pickAgentSessionOption,
  recordAgentSessionRanOptions,
  replaceAgentSessionRecordOptions,
  type AgentSessionOptionPick,
  type AgentSessionRanOptions
} from './agent-session-record-options'
import {
  setAgentSessionRecordConversationName,
  setAgentSessionRecordUserName,
  type AgentSessionUserNameWrite
} from './agent-session-record-conversation-name'

type WithoutRecord<F extends (...args: never[]) => unknown> = Omit<Parameters<F>[0], 'record'>

export type AgentSessionRecordCommand =
  | { kind: 'name'; name: string | null; now: number }
  | { kind: 'user-name'; name: string; write: AgentSessionUserNameWrite; now: number }
  | {
      kind: 'name-if-current'
      name: string | null
      expected: string | null
      contextId: string | null
      now: number
    }
  | { kind: 'launch-directory'; launchDirectory: string; now: number }
  | { kind: 'options'; args: AgentSessionOptionsReplacement }
  | { kind: 'pick-option'; args: AgentSessionOptionPick }
  | { kind: 'ran-options'; args: AgentSessionRanOptions }
  | { kind: 'process'; args: WithoutRecord<typeof commitAgentSessionProcessIdentity> }
  | {
      kind: 'prove'
      args: Parameters<ReturnType<typeof createAgentSessionOwnerProof>>[0]
      leaseTtlMs: number
    }
  | { kind: 'evict'; args: WithoutRecord<typeof evictAgentSessionOwner> }
  | { kind: 'release-unproven'; args: WithoutRecord<typeof releaseUnprovenAgentSessionOwner> }
  | { kind: 'provider-handle'; args: WithoutRecord<typeof recordAgentSessionProviderHandle> }
  | { kind: 'resume-point'; args: WithoutRecord<typeof reviseAgentSessionProviderResumePoint> }
  | {
      kind: 'release-surface'
      args: WithoutRecord<typeof releaseAgentSessionOwnerAfterSurfaceClose>
    }
  | { kind: 'cancel-continue'; cut: UsageLimitContinueIdentity }
  | { kind: 'last-turn'; lastTurn?: AgentSessionLastTurn }
  | { kind: 'rewind'; fence: number; rewind: AgentSessionRewindRecord }
  | { kind: 'sleep'; now: number; fence: number }
  | {
      kind: 'acquisition-exit'
      receipt: Parameters<typeof recordAgentSessionAcquisitionExit>[1]
      fence: number
      now: number
      deathEvidenceKind?: 'kill-delivered'
    }
  | { kind: 'exit-observed'; fence: number; observedAt: number }

export type AgentSessionRecordCommandResult<C extends AgentSessionRecordCommand> = C extends {
  kind: 'user-name'
}
  ? { record: AgentSessionRecord; applied: boolean }
  : C extends { kind: 'name-if-current' | 'sleep' }
    ? AgentSessionRecord | null
    : AgentSessionRecord

export function applyAgentSessionRecordCommand(
  record: AgentSessionRecord,
  command: AgentSessionRecordCommand
): {
  record: AgentSessionRecord
  result: AgentSessionRecordCommandResult<AgentSessionRecordCommand>
} {
  let next: AgentSessionRecord
  switch (command.kind) {
    case 'name':
      next = setAgentSessionRecordConversationName(record, command.name, command.now)
      break
    case 'user-name': {
      const result = setAgentSessionRecordUserName(record, command.name, command.write, command.now)
      return { record: result.record, result }
    }
    case 'name-if-current':
      if (
        record.conversationNameSource === 'user' ||
        (record.conversationName ?? null) !== command.expected ||
        (record.providerContextBoundary?.operationId ?? null) !== command.contextId
      ) {
        return { record, result: null }
      }
      next = setAgentSessionRecordConversationName(record, command.name, command.now)
      break
    case 'launch-directory':
      next = pinAgentSessionRecordLaunchDirectory(record, command.launchDirectory, command.now)
      break
    case 'options':
      next = replaceAgentSessionRecordOptions(record, command.args)
      break
    case 'pick-option':
      next = pickAgentSessionOption(record, command.args)
      break
    case 'ran-options':
      next = recordAgentSessionRanOptions(record, command.args)
      break
    case 'process':
      next = commitAgentSessionProcessIdentity({ ...command.args, record })
      break
    case 'prove': {
      const { launchedAccount: _previous, ...proved } = withAcquiredAgentSessionAccount(
        proveAgentSessionOwner({
          ...command.args,
          record,
          leaseTtlMs: command.args.leaseTtlMs ?? command.leaseTtlMs
        }),
        command.args.accountAcquisition
      )
      next = command.args.launchedAccountHome
        ? {
            ...proved,
            launchedAccount: {
              fence: command.args.fence,
              accountHome: command.args.launchedAccountHome
            }
          }
        : proved
      break
    }
    case 'evict':
      next = evictAgentSessionOwner({ ...command.args, record })
      break
    case 'release-unproven':
      next = releaseUnprovenAgentSessionOwner({ ...command.args, record })
      break
    case 'provider-handle':
      next = recordAgentSessionProviderHandle({ ...command.args, record })
      break
    case 'resume-point':
      next = reviseAgentSessionProviderResumePoint({ ...command.args, record })
      break
    case 'release-surface':
      next = releaseAgentSessionOwnerAfterSurfaceClose({ ...command.args, record })
      break
    case 'cancel-continue':
      next = cancelAgentSessionUsageLimitContinue(record, command.cut)
      break
    case 'last-turn': {
      const { lastTurn: previous, ...rest } = record
      next = command.lastTurn ? { ...rest, lastTurn: command.lastTurn } : previous ? rest : record
      break
    }
    case 'rewind':
      if (record.lease.runtimeFence !== command.fence) {
        throw new Error('agent_session_checkpoint_stale')
      }
      next = { ...record, rewind: command.rewind }
      break
    case 'sleep':
      if (record.lease.runtimeFence !== command.fence) {
        throw new Error('agent_session_checkpoint_stale')
      }
      next = { ...record, sleptAt: command.now, updatedAt: command.now }
      break
    case 'acquisition-exit':
      next = recordAgentSessionAcquisitionExit(
        record,
        command.receipt,
        command.fence,
        command.now,
        command.deathEvidenceKind
      )
      break
    case 'exit-observed':
      next =
        record.lease.claimStatus === 'released' &&
        record.lease.deathEvidence?.kind === 'kill-delivered' &&
        record.lease.deathEvidence.ownerFence === command.fence
          ? {
              ...record,
              lease: {
                ...record.lease,
                deathEvidence: {
                  ...record.lease.deathEvidence,
                  kind: 'exit-observed',
                  observedAt: command.observedAt
                }
              }
            }
          : record
  }
  return { record: next, result: next }
}
