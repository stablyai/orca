import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentPromptPasteBytes, getAgentPromptSubmitDelayMs } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_ECHO_POLL_INTERVAL_MS,
  AGENT_PROMPT_ECHO_SETTLE_MS,
  AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT,
  AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32
} from './agent-prompt-paste-echo'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// Why: this suite isolates the renderGate branch's structural guarantee -- independent of
// createAgentPromptRenderGate's own settlement heuristic -- that Enter cannot overtake the
// ingest floor even when the render signal itself fires early (redraw races, a settlement
// agent that repaints before attaching a completed paste, etc) -- and the paste-echo wait
// layered on top of it, which additionally holds Enter until the pane demonstrably consumed
// the paste (agent_prompt_stalled ticket: Windows Codex composer redraws per keystroke).
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

// Why 12 KB: one chunk (so the write loop costs no clock, matching the ticket's observed
// 10,714/12,773-byte payloads), while still large enough that the ConPTY ingest term is well
// above the flat 500 ms settle a resolved-immediately gate would otherwise stop at.
const PROMPT = 'y'.repeat(12_000)
// Why: matches the 24-char echo probe derived from PROMPT's tail (all 'y's).
const PROMPT_TAIL_ECHO = 'y'.repeat(24)

function floorMsFor(platform: NodeJS.Platform): number {
  return getAgentPromptSubmitDelayMs(
    platform,
    Buffer.byteLength(buildAgentPromptPasteBytes(PROMPT), 'utf8')
  )
}

describe('agent prompt render gate ingest floor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('does not write Enter before the ingest floor when the render gate resolves early, and holds for the paste-echo settle once it is observed', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // Why: the pane already echoed the paste tail well before the floor -- the echo wait only
    // starts once the floor's Promise.all resolves, so it cannot shorten this window, but it
    // does add its settle on top once that point is reached.
    await vi.advanceTimersByTimeAsync(0)
    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())

    // Flush the render gate's already-resolved promise without advancing real time.
    await vi.advanceTimersByTimeAsync(0)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(floorMs - 1)
    expect(countSubmits(writes)).toBe(0)

    // The floor has elapsed; the echo is already visible, but the extra settle has not.
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ECHO_SETTLE_MS - 1)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBe(floorMs + AGENT_PROMPT_ECHO_SETTLE_MS)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('does not write Enter at the floor when the pane has not echoed the paste, and writes it shortly after a late echo', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // Floor elapses with no echo yet -- Enter must not fire.
    await vi.advanceTimersByTimeAsync(floorMs + 6_000 - 1)
    expect(countSubmits(writes)).toBe(0)

    // The echo lands right before the next 100 ms poll tick, at floor + 6_000 ms.
    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(0)

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ECHO_SETTLE_MS - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBe(floorMs + 6_000 + AGENT_PROMPT_ECHO_SETTLE_MS)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('does not accept a probe already present in scrollback before the paste write', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_SETTLE_MS)
    expect(countSubmits(writes)).toBe(0)

    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ECHO_POLL_INTERVAL_MS + AGENT_PROMPT_ECHO_SETTLE_MS)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('does not accept the first attempt\'s echo on the first poll after a retry paste', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    const firstSubmission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const firstStalled = expect(firstSubmission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(0)
    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())
    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_SETTLE_MS)
    expect(countSubmits(writes)).toBe(1)
    await vi.runAllTimersAsync()
    await firstStalled

    const retrySubmission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const retryStalled = expect(retrySubmission).rejects.toThrow('agent_prompt_stalled')
    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_POLL_INTERVAL_MS)
    expect(countSubmits(writes)).toBe(1)

    runtime.onPtyData(PTY_ID, PROMPT_TAIL_ECHO, Date.now())
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_ECHO_POLL_INTERVAL_MS + AGENT_PROMPT_ECHO_SETTLE_MS)
    expect(countSubmits(writes)).toBe(2)

    await vi.runAllTimersAsync()
    await retryStalled
  })

  it('falls back to writing Enter at the echo deadline when the pane never echoes the paste', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32 - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBe(floorMs + AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32)

    await vi.runAllTimersAsync()
    // Why: the deadline is a fallback, not proof the paste landed -- verification still owns
    // the final verdict, and no evidence of a turn start means it still stalls.
    await stalled
  })

  it('treats a paste-collapse placeholder ("[Pasted text #1 +N lines]") as the paste echo', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(0)
    runtime.onPtyData(PTY_ID, '[Pasted text #1 +40 lines]', Date.now())

    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_SETTLE_MS - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBe(floorMs + AGENT_PROMPT_ECHO_SETTLE_MS)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('uses the shorter 3 s echo deadline on a non-win32 write host', async () => {
    useHostPlatform('darwin')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } =
      await createSettlementRuntimeWithImmediateRenderGate()
    const floorMs = floorMsFor('darwin')
    const submission = runtime.sendTerminalAgentPrompt(handle, PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(floorMs + AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)
    expect(submitTimes[0]).toBe(floorMs + AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT)

    await vi.runAllTimersAsync()
    await stalled
  })
})
