import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentPromptInjection from '../../shared/agent-prompt-injection'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// Why: vi.mock factories are hoisted above module-scope consts, so the delay must be hoisted too.
const { WINDOWS_SUBMIT_DELAY_MS } = vi.hoisted(() => ({ WINDOWS_SUBMIT_DELAY_MS: 1_500 }))
const WORKTREE_PATH = '/tmp/worktree-a'

// Why: AGENT_PROMPT_SUBMIT_DELAY_MS is frozen from process.platform at import, so the 1_500 ConPTY
// path is otherwise unreachable on the Linux/macOS lanes that run this suite.
vi.mock('../../shared/agent-prompt-injection', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentPromptInjection>()),
  AGENT_PROMPT_SUBMIT_DELAY_MS: WINDOWS_SUBMIT_DELAY_MS
}))

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

// Why: 'aider' is not a settlement agent, so submission takes the fixed-delay branch under test.
async function createPromptRuntime(): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    launchAgent: 'aider'
  })
  return { runtime, handle: terminal.handle, writes }
}

function countSubmits(writes: readonly string[]): number {
  return writes.filter((data) => data === '\r').length
}

describe('agent prompt submission at the Windows submit delay', () => {
  afterEach(() => vi.useRealTimers())

  it('holds Enter until the full platform delay elapses', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(WINDOWS_SUBMIT_DELAY_MS - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('does not send another Enter after cancellation during verification', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(WINDOWS_SUBMIT_DELAY_MS)
    expect(countSubmits(writes)).toBe(1)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(countSubmits(writes)).toBe(1)
  })
})
