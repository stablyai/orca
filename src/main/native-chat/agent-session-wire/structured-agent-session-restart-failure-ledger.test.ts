import { describe, expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { createStructuredAgentSessionRestartFailureLedger } from './structured-agent-session-restart-failure-ledger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE } from './structured-agent-session-restart-resume-runner'

const PROMPT = 'private prompt the user typed'

const adapter: StructuredAgentSessionAdapter = {
  acquire: async () => {
    throw new Error('not acquired in this test')
  },
  dispatch: async () => {
    throw new Error('not dispatched in this test')
  },
  cancelTurn: async () => ({ cancelled: false }),
  answerPrompt: async () => undefined,
  setOption: async () => undefined
}

describe('restart failure ledger settlement', () => {
  it('names the operation and every affected session when a capsule write fails, and no error', async () => {
    const log = recordingStructuredAgentSessionLogger()
    // A capsule error can quote the recovery payload, which holds the user's prompt.
    const fail = async (): Promise<never> => {
      throw new Error(`capsule write failed: ${PROMPT}`)
    }
    const ledger = createStructuredAgentSessionRestartFailureLedger({
      capsule: {
        listFailed: async () => [],
        completeResume: fail,
        failResume: fail,
        rollbackResume: fail,
        dismiss: async () => 0,
        clearAll: async () => 0
      },
      getRecord: () => null,
      adapter,
      retryable: () => false,
      reveal: async () => undefined,
      logger: log.logger,
      now: () => 1_000,
      enqueue: (operation) => operation()
    })

    await ledger.settle(
      'operation-1',
      [
        {
          sessionId: 'session-done',
          outcome: 'refused',
          reason: STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE
        },
        { sessionId: 'session-a', outcome: 'refused', reason: 'agent_session_resume_refused' },
        { sessionId: 'session-b', outcome: 'refused', reason: 'agent_session_resume_refused' }
      ],
      {
        candidates: [],
        markers: new Map(),
        failureAfterResume: () => null,
        failureReason: () => 'unused'
      }
    )

    expect(log.entries.map(({ fields }) => fields)).toEqual([
      { scope: 'restart-offer-complete', operationId: 'operation-1', sessionIds: ['session-done'] },
      {
        scope: 'restart-failure-record',
        operationId: 'operation-1',
        sessionIds: ['session-a', 'session-b']
      },
      {
        scope: 'restart-offer-rollback',
        operationId: 'operation-1',
        sessionIds: ['session-done', 'session-a', 'session-b']
      }
    ])
    expect(JSON.stringify(log.entries)).not.toContain(PROMPT)
  })
})
