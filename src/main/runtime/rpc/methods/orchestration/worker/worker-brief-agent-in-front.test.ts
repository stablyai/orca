import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LaunchedAgentForeground } from '../../../../launched-agent-foreground'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const PTY_ID = 'pty_worker'

// Why: a shell back at its prompt after the agent exits reads as ready too, so the brief needs the
// launched agent found in front, or the shell runs it. Amp takes its brief only after it starts, so
// it is pasted rather than carried on the launch line.
describe('a worker start writes its brief only into the agent it launched', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  function launchedPane(foreground: LaunchedAgentForeground): string[] {
    h.setup()
    const writes: string[] = []
    vi.spyOn(h.runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
    vi.spyOn(h.runtime, 'launchedAgentHostProvesAgent').mockReturnValue(true)
    vi.spyOn(h.runtime, 'subscribeToTerminalData').mockReturnValue(() => {})
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementation(
      async (handle, text, options) => {
        await options?.beforeWrite?.(PTY_ID)
        writes.push(text)
        return { handle, accepted: true, bytesWritten: text.length }
      }
    )
    return writes
  }

  it('types nothing when the agent exited and its shell is in front', async () => {
    const writes = launchedPane('shell')

    await expect(h.startWorker({ agent: 'amp' })).rejects.toThrow()
    expect(writes).toEqual([])
  })

  it('writes the brief once into the agent found in front', async () => {
    const writes = launchedPane('agent')

    await h.startWorker({ agent: 'amp' })
    expect(writes).toHaveLength(1)
  })

  it('leaves a terminal the caller supplied to its own idle wait', async () => {
    const writes = launchedPane('shell')

    await h.startWorker({ terminal: 'term_worker' })
    expect(h.runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
  })
})
