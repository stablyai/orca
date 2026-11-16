import { expect, it } from 'vitest'
import { createStructuredAgentSessionConversationReads } from './structured-agent-session-conversation-reads'

it('preserves remaining individually held input at the public host boundary', async () => {
  const reads = createStructuredAgentSessionConversationReads(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this boundary test only invokes resumeFailure; the journal stub owns its write and never calls preparation.
      ({
        serialize: async (_id: string, run: () => Promise<unknown>) => run(),
        conversation: async () => ({
          journal: {
            write: async () => ({
              value: {
                status: 'resumed',
                waiting: 2,
                stillHeld: 1,
                heldReason: 'held individually'
              }
            })
          }
        }),
        onFailureResumed: () => {}
      }) as never
  )
  expect(
    await reads.resumeFailure(
      'worker',
      {
        expectedFailureId: 'observed-failure',
        operationId: 'resume',
        coordinatorId: 'coordinator',
        dispatchId: 'dispatch',
        expectedRuntimeFence: 1,
        authorization: { runId: 'run', snapshot: '[]' }
      },
      () => {}
    )
  ).toEqual({ status: 'resumed', waiting: 2, stillHeld: 1, heldReason: 'held individually' })
})
