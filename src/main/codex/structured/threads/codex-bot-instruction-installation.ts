import { randomUUID } from 'node:crypto'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import { agentSessionInstructionScope as codexInstructionScope } from '../../../runtime/agent-session/records/agent-session-instruction-scope'
import type { AgentSessionInstructionPolicy } from '../../../../shared/agent-session/agent-session-instruction-policy'
import type { AgentSessionInstructionSnapshot } from '../../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { AgentSessionStartFailure } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import {
  agentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { codexMethodUnavailable } from '../catalog/codex-structured-applied-settings'
import { priorInstructionComparison } from '../../../runtime/agent-session/records/agent-session-opened-instruction-policy'

export function codexInstructionFailure(
  reason: NonNullable<AgentSessionFailureFact['instructionRecovery']>,
  cause?: unknown
): AgentSessionStartFailure {
  return new AgentSessionStartFailure(
    cause ?? reason,
    'never',
    agentSessionFailureFact('startFailed', { instructionRecovery: reason, neverReachedAgent: true })
  )
}

export type CodexInstructionInstallation = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'updateRecord'>
  snapshot: AgentSessionInstructionSnapshot
  account: string
}

export async function installCodexBotInstructions(input: {
  installation: CodexInstructionInstallation
  connection: Pick<CodexAppServerConnection, 'request'>
  sessionId: string
  nativeId: string
  generation: string
  anchor: string
  fence: number
  fresh: boolean
  historyUnchanged: boolean
  hideItem?: (id: string) => void
  signal: AbortSignal
  assertCurrent: () => void
}): Promise<{ policy: AgentSessionInstructionPolicy; filesIncluded: boolean }> {
  const {
    installation: { store, snapshot, account },
    sessionId,
    nativeId,
    generation,
    anchor,
    fence,
    signal
  } = input
  input.assertCurrent()
  const record = store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_record_missing')
  }
  const scope = codexInstructionScope(record, account)
  const prior = record.instructionPolicy
  if (prior) {
    input.hideItem?.(prior.operationId)
  }
  if (
    prior?.state === 'pending' &&
    prior.nativeId === nativeId &&
    record.lease.deathEvidence?.ownerFence !== prior.fence
  ) {
    throw codexInstructionFailure('pending')
  }
  const matching =
    input.historyUnchanged &&
    prior?.state === 'delivered' &&
    prior.botId === snapshot.botId &&
    prior.scope === scope &&
    prior.nativeId === nativeId &&
    prior.standing === snapshot.standing &&
    (!snapshot.baseline || prior.baseline !== undefined) &&
    record.providerHandleChain.at(-1)?.linkId === prior.anchor
  const receipt: AgentSessionInstructionPolicy = {
    version: 1,
    botId: snapshot.botId,
    standing: snapshot.standing,
    snapshot: snapshot.digest,
    scope,
    nativeId,
    generation,
    anchor,
    fence,
    operationId: `orca-policy-${randomUUID()}`,
    state: 'delivered',
    ...(snapshot.baseline ? { baseline: snapshot.baseline } : {})
  }
  if (input.fresh) {
    return { policy: receipt, filesIncluded: true }
  }
  if (matching) {
    return {
      policy: {
        ...receipt,
        operationId: prior.operationId,
        snapshot: prior.snapshot,
        baseline: prior.baseline
      },
      filesIncluded: false
    }
  }
  const comparison = priorInstructionComparison(record, receipt)
  const repair = comparison
    ? { ...receipt, baseline: comparison.baseline, comparisonAnchor: comparison.anchor }
    : receipt
  await store
    .updateRecord(
      sessionId,
      {
        kind: 'instruction-pending',
        account,
        policy: repair,
        priorOperationId: prior?.operationId
      },
      input.assertCurrent
    )
    .catch((error: unknown) => {
      throw codexInstructionFailure('commit', error)
    })
  input.assertCurrent()
  input.hideItem?.(receipt.operationId)
  await waitForPromiseWithSignal(
    input.connection.request(
      'thread/inject_items',
      {
        threadId: nativeId,
        items: [
          {
            type: 'message',
            id: receipt.operationId,
            role: 'developer',
            content: [{ type: 'input_text', text: snapshot.text }]
          }
        ]
      },
      { timeoutMs: null }
    ),
    signal
  ).catch((error: unknown) => {
    if (codexMethodUnavailable(error, 'thread/inject_items')) {
      throw codexInstructionFailure('unsupported', error)
    }
    throw codexInstructionFailure(signal.aborted ? 'timeout' : 'unknown', error)
  })
  input.assertCurrent()
  return { policy: repair, filesIncluded: true }
}
