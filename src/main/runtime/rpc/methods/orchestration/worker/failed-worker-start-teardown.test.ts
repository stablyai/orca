import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../orchestration-structured-worker-session'

vi.mock('../../orchestration-structured-worker-session', () => ({
  discardStructuredWorkerSession: vi.fn(async () => {}),
  releaseStructuredWorkerSession: vi.fn(() => {})
}))

const SESSION_ID = 'session-1'
const DISPATCH_ID = 'ctx_1'

type TearDownArgs = Parameters<typeof tearDownFailedWorkerStart>[0]

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the teardown never reads the runtime; it only forwards it to the two mocked collaborators asserted below.
const RUNTIME = {} as OrcaRuntimeService
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the teardown reads only `identity.sessionId` off the structured session.
const STRUCTURED_SESSION = {
  identity: { sessionId: SESSION_ID }
} as TearDownArgs['structuredSession']

async function tearDown(error: unknown): Promise<void> {
  await tearDownFailedWorkerStart({
    runtime: RUNTIME,
    structuredSession: STRUCTURED_SESSION,
    dispatchId: DISPATCH_ID,
    error
  })
}

describe('tearDownFailedWorkerStart', () => {
  beforeEach(() => {
    vi.mocked(discardStructuredWorkerSession).mockClear()
    vi.mocked(releaseStructuredWorkerSession).mockClear()
  })

  // CX1/SF4: the preamble WAS submitted and codex had already started the turn, but the pending
  // dispatchState threw `operation_unknown` and the catch-all teardown closed the live child —
  // Orca destroying a healthy worker, and the very session the receipt says to go inspect.
  it('keeps a structured session whose preamble may still be running', async () => {
    await tearDown(
      new OrchestrationError(
        'operation_unknown',
        'The dispatch preamble was submitted but not acknowledged (pending): no reason given.'
      )
    )

    expect(discardStructuredWorkerSession).not.toHaveBeenCalled()
    // The hold stays too. Dropping it arms the 15s clock, and its only remaining guard is an
    // active-turn projection a delayed acknowledgement may not have produced yet.
    expect(releaseStructuredWorkerSession).not.toHaveBeenCalled()
  })

  it('discards the session when the preamble provably did not land', async () => {
    await tearDown(
      new OrchestrationError('dispatch_preamble_undelivered', 'The dispatch preamble was not delivered.')
    )

    expect(discardStructuredWorkerSession).toHaveBeenCalledWith(SESSION_ID, RUNTIME)
  })

  it('discards the session for an ordinary start failure', async () => {
    await tearDown(new Error('terminal authority missing'))

    expect(discardStructuredWorkerSession).toHaveBeenCalledWith(SESSION_ID, RUNTIME)
  })

  it('discards the session when the caller reported no error at all', async () => {
    await tearDownFailedWorkerStart({
      runtime: RUNTIME,
      structuredSession: STRUCTURED_SESSION,
      dispatchId: DISPATCH_ID
    })

    expect(discardStructuredWorkerSession).toHaveBeenCalledWith(SESSION_ID, RUNTIME)
  })

  it('still releases the hold when there is no structured session', async () => {
    await tearDownFailedWorkerStart({
      runtime: RUNTIME,
      structuredSession: null,
      dispatchId: DISPATCH_ID,
      error: new Error('boom')
    })

    expect(discardStructuredWorkerSession).not.toHaveBeenCalled()
    expect(releaseStructuredWorkerSession).toHaveBeenCalledWith(DISPATCH_ID, RUNTIME)
  })
})
