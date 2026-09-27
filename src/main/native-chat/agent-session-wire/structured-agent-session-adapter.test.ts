import { describe, expect, it, vi } from 'vitest'

import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'

describe('failed agent-session acquisition cleanup', () => {
  it('names a failure exit-proven after proven cleanup, keeping its diagnostic and cause', async () => {
    const cause = new Error('proof failed')
    const thrown = await rethrowAfterAgentSessionAcquisitionCleanup(
      { releaseAcquisition: vi.fn(async () => true) },
      'session-1',
      cause
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(AgentSessionAcquisitionExitProvenError)
    expect(thrown).toMatchObject({ message: 'proof failed', cause })
  })

  it.each([
    ['a refusal', new AgentSessionAcquisitionRefusal('not signed in')],
    ['a root exit', new AgentSessionAcquisitionRootExitObservedError(new Error('exited'))],
    ['a host store code', new Error('agent_session_checkpoint_stale')]
  ])('keeps %s that already names its verdict after proven cleanup', async (_label, cause) => {
    await expect(
      rethrowAfterAgentSessionAcquisitionCleanup(
        { releaseAcquisition: vi.fn(async () => true) },
        'session-1',
        cause
      )
    ).rejects.toBe(cause)
  })

  it('reports unproven exit when cleanup returns false', async () => {
    await expect(
      rethrowAfterAgentSessionAcquisitionCleanup(
        { releaseAcquisition: vi.fn(async () => false) },
        'session-1',
        new Error('proof failed')
      )
    ).rejects.toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
  })

  it('keeps a first-hand root exit that cleanup observed, with the provider diagnostic', async () => {
    const cause = new Error('proof failed')
    const exit = new AgentSessionAcquisitionRootExitObservedError(
      new Error('claude stream-json exited (code 1): crashed')
    )
    const error = await rethrowAfterAgentSessionAcquisitionCleanup(
      {
        releaseAcquisition: vi.fn(async () => {
          throw exit
        })
      },
      'session-1',
      cause
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
    expect(error).not.toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
    expect((error as Error).message).toBe('claude stream-json exited (code 1): crashed')
    expect((error as Error).cause).toMatchObject({ errors: [cause, exit] })
  })

  it('reports unproven exit when cleanup throws', async () => {
    const error = await rethrowAfterAgentSessionAcquisitionCleanup(
      {
        releaseAcquisition: vi.fn(async () => {
          throw new Error('cleanup failed')
        })
      },
      'session-1',
      new Error('proof failed')
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
    expect(error).toMatchObject({ cause: expect.any(AggregateError) })
  })
})
