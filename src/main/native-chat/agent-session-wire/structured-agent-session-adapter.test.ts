import { describe, expect, it, vi } from 'vitest'

import {
  AgentSessionAcquisitionExitUnprovenError,
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
