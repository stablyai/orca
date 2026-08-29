import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionHandoffStage } from '../../shared/agent-session-record'
import {
  abandonAgentSessionHandoffAttempt,
  recoverDeadTuiOwnerForHandoff,
  reserveAgentSessionHandoffOwner,
  rollbackAgentSessionHandoffPreparation,
  stopAgentSessionOwnerForHandoff,
  stopRecoveringTuiOwnerForHandoff
} from './agent-session-handoff-lease-transitions'
import { setAgentSessionHandoffStage } from './agent-session-lease-transitions'
import {
  AGENT_SESSION_LEASE_TTL_MS,
  type AgentSessionRecordStore
} from './agent-session-record-store'

export function setStoredAgentSessionHandoffStage(
  store: AgentSessionRecordStore,
  args: {
    sessionId: string
    fence: number
    stage: AgentSessionHandoffStage | null
    handoffOperationId: string | null
    now: number
  }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    setAgentSessionHandoffStage({ ...args, record })
  )
}

export function recoverStoredDeadTuiOwnerForHandoff(
  store: AgentSessionRecordStore,
  args: {
    sessionId: string
    expectedFence: number
    operationId: string
    probe: AgentSessionOwnerProbe
    now: number
  }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    recoverDeadTuiOwnerForHandoff({ ...args, record })
  )
}

export function stopStoredAgentSessionOwnerForHandoff(
  store: AgentSessionRecordStore,
  args: { sessionId: string; expectedFence: number; operationId: string; now: number }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    stopAgentSessionOwnerForHandoff({ ...args, record })
  )
}

export function rollbackStoredAgentSessionHandoffPreparation(
  store: AgentSessionRecordStore,
  args: { sessionId: string; expectedFence: number; operationId: string; now: number }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    rollbackAgentSessionHandoffPreparation({ ...args, record })
  )
}

export function stopStoredRecoveringTuiOwnerForHandoff(
  store: AgentSessionRecordStore,
  args: { sessionId: string; expectedFence: number; operationId: string; now: number }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    stopRecoveringTuiOwnerForHandoff({ ...args, record })
  )
}

export function reserveStoredAgentSessionHandoffOwner(
  store: AgentSessionRecordStore,
  args: {
    sessionId: string
    expectedFence: number
    runtimeKind: 'native' | 'tui'
    spawnToken: string
    operationId: string
    claimKeyId: string
    now: number
    leaseTtlMs?: number
  }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    reserveAgentSessionHandoffOwner({
      ...args,
      record,
      leaseTtlMs: args.leaseTtlMs ?? AGENT_SESSION_LEASE_TTL_MS
    })
  )
}

export function abandonStoredAgentSessionHandoffAttempt(
  store: AgentSessionRecordStore,
  args: {
    sessionId: string
    expectedFence: number
    operationId: string
    recoverableRuntimeKind: 'native' | 'tui'
    now: number
  }
) {
  return store.transitionHandoff(args.sessionId, (record) =>
    abandonAgentSessionHandoffAttempt({ ...args, record })
  )
}
