import { describe, expect, it, vi } from 'vitest'
import { waitForWorkerAgentTuiReady } from './orchestration-worker-agent-readiness'

describe('waitForWorkerAgentTuiReady', () => {
  it('returns the first wait when it is not satisfied', async () => {
    const waitForTerminal = vi.fn().mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const result = await waitForWorkerAgentTuiReady({
      runtime: { waitForTerminal },
      terminalHandle: 'term_worker',
      timeoutMs: 30_000,
      externalTerminal: false
    })

    expect(result).toMatchObject({ satisfied: false, status: 'exited' })
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
  })

  it('skips settle re-wait for an external --terminal agent', async () => {
    const waitForTerminal = vi.fn().mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })

    await waitForWorkerAgentTuiReady({
      runtime: { waitForTerminal },
      terminalHandle: 'term_worker',
      timeoutMs: 30_000,
      externalTerminal: true
    })

    expect(waitForTerminal).toHaveBeenCalledTimes(1)
  })

  it('re-confirms tui-idle after settle for Orca-created agents', async () => {
    const waitForTerminal = vi
      .fn()
      .mockResolvedValueOnce({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      .mockResolvedValueOnce({
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })

    const result = await waitForWorkerAgentTuiReady({
      runtime: { waitForTerminal },
      terminalHandle: 'term_worker',
      timeoutMs: 30_000,
      externalTerminal: false
    })

    expect(result).toMatchObject({ satisfied: true })
    expect(waitForTerminal).toHaveBeenCalledTimes(2)
    expect(waitForTerminal.mock.calls[0]?.[1]).toMatchObject({
      condition: 'tui-idle',
      timeoutMs: 30_000
    })
    expect(waitForTerminal.mock.calls[1]?.[1]).toMatchObject({
      condition: 'tui-idle'
    })
  })
})
