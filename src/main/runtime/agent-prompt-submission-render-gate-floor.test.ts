import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentPromptPasteBytes, getAgentPromptSubmitDelayMs } from '../../shared/agent-prompt-injection'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// Why: this suite isolates the renderGate branch's structural guarantee -- independent of
// createAgentPromptRenderGate's own settlement heuristic -- that Enter cannot overtake the
// ingest floor even when the render signal itself fires early (redraw races, a settlement
// agent that repaints before attaching a completed paste, etc).
const WORKTREE_PATH = '/tmp/worktree-a'
const PTY_ID = 'pty-prompt'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function useHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

function countSubmits(writes: readonly string[]): number {
  return writes.filter((data) => data === '\r').length
}

/** Stubs the settlement agent's render gate to resolve on the very next microtask, the way
 *  an early redraw would, so the test isolates whether the ingest floor still applies. */
async function createSettlementRuntimeWithImmediateRenderGate(): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
  submitTimes: number[]
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  vi.spyOn(
    OrcaRuntimeService.prototype as unknown as {
      createAgentPromptRenderGate: (
        ptyId: string,
        pasteIngestMs: number
      ) => { arm: () => void; wait: () => Promise<void>; dispose: () => void } | null
    },
    'createAgentPromptRenderGate'
  ).mockReturnValue({
    arm: () => {},
    wait: () => Promise.resolve(),
    dispose: () => {}
  })
  const writes: string[] = []
  const submitTimes: number[] = []
  const startedAt = Date.now()
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r') {
        submitTimes.push(Date.now() - startedAt)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    launchAgent: 'claude'
  })
  return { runtime, handle: terminal.handle, writes, submitTimes }
}

describe('agent prompt render gate ingest floor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('does not write Enter before the ingest floor when the render gate resolves early', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    // Why 12 KB: one chunk (so the write loop costs no clock, matching the ticket's observed
    // 10,714/12,773-byte payloads), while still large enough that the ConPTY ingest term is
    // well above the flat 500 ms settle a resolved-immediately gate would otherwise stop at.
    const prompt = 'y'.repeat(12_000)
    const floorMs = getAgentPromptSubmitDelayMs(
      'win32',
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // Flush the render gate's already-resolved promise without advancing real time.
    await vi.advanceTimersByTimeAsync(0)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(floorMs - 1)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBeGreaterThanOrEqual(floorMs)

    await vi.runAllTimersAsync()
    await stalled
  })
})

