import { describe, expect, it, vi } from 'vitest'

import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'

describe('failed agent-session acquisition cleanup', () => {
  it('preserves the acquisition failure after proven cleanup', async () => {
    const cause = new Error('proof failed')

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
