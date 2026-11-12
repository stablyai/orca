import type {
  AgentSessionExecutionReceiptWrite,
  AgentSessionExecutionReceipt
} from '../../../../shared/agent-session/agent-session-execution-receipt'
import type { AgentSessionExecutionReporterFactory } from '../../../../shared/agent-session/agent-session-execution-report'
import { createHash } from 'node:crypto'
import type { CodexSession } from './codex-structured-session-state'

export async function persistCodexExecutionReceipt(
  session: Pick<CodexSession, 'execution'>,
  closure?: AgentSessionExecutionReceipt['closure']
): Promise<void> {
  const execution = session.execution
  if (!execution?.lastEvidence || !execution.record || !execution.binding) {
    return
  }
  const { usage: _previousUsage, ...evidence } = execution.lastEvidence
  await execution.record({
    ...execution.binding,
    receipt: {
      version: 1,
      spawnTokenHash: createHash('sha256').update(execution.binding.spawnToken).digest('hex'),
      invalidated: execution.invalidated,
      turnCompleted: execution.turnCompleted,
      execution: {
        ...evidence,
        ...(execution.usage ? { usage: { ...execution.usage } } : {}),
        ...(evidence.bounded
          ? { bounded: { ...evidence.bounded, inputAdmitted: execution.inputAdmitted } }
          : {})
      },
      ...(execution.report ? { report: { ...execution.report } } : {}),
      ...(closure ? { closure } : {})
    }
  })
}

export function bindCodexExecutionCheckpoint(session: CodexSession): void {
  const execution = session.execution
  if (!execution) {
    return
  }
  execution.checkpoint = () => {
    void persistCodexExecutionReceipt(session).catch(() => {
      execution.invalidated = true
      execution.controls.stop()
    })
  }
}

export type CodexExecutionAdapterDeps = {
  onExecutionReceipt?: (write: AgentSessionExecutionReceiptWrite) => Promise<void>
  prepareExecutionReporter?: AgentSessionExecutionReporterFactory
}
