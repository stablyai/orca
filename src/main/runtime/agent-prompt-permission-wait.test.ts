import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { AGENT_PROMPT_PERMISSION_RECHECK_MS } from './terminal/input/agent-prompt-permission-hold'

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

const PERMISSION_TITLE = '\x1b]0;Codex waiting for permission\x07'
const IDLE_TITLE = '\x1b]0;Codex idle\x07'
const WORKING_TITLE = '\x1b]0;Codex working\x07'

/** A runtime whose agent starts a turn on Enter, so an accepted prompt settles. */
async function createRuntime() {
  return createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data === '\r') {
      runtime.onPtyData('pty-prompt', WORKING_TITLE, Date.now())
    }
  })
}

function pasted(writes: readonly string[], text: string): number {
  return writes.filter((data) => data.includes(text)).length
}

describe('agent prompt writer: onPermission wait', () => {
  afterEach(() => vi.useRealTimers())

  it('holds while the agent asks for permission and writes once it is answered', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())

    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait'
    })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_PERMISSION_RECHECK_MS * 5)
    expect(writes).toEqual([])

    runtime.onPtyData('pty-prompt', IDLE_TITLE, Date.now())
    await vi.runAllTimersAsync()

    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(pasted(writes, 'held prompt')).toBe(1)
  })

  it('does not hold another caller: a refusing prompt still refuses while one waits', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
    const held = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait'
    })
    void held.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'refused prompt', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('resumes the hold when the approval returns during the final pre-paste check', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    let checks = 0
    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait',
      beforeWrite: async () => {
        checks += 1
        if (checks === 1) {
          // The guard's async read is where an approval can slip in before the paste.
          runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
        }
      }
    })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_PERMISSION_RECHECK_MS * 3)
    expect(writes).toEqual([])

    runtime.onPtyData('pty-prompt', IDLE_TITLE, Date.now())
    await vi.runAllTimersAsync()

    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(pasted(writes, 'held prompt')).toBe(1)
  })

  it('refuses when the process restarts during the hold', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait'
    })
    const rejected = expect(sent).rejects.toThrow('terminal_handle_stale')
    await vi.advanceTimersByTimeAsync(0)

    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_PERMISSION_RECHECK_MS)

    await rejected
    expect(writes).toEqual([])
  })

  it('ends the hold when the process exits', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait'
    })
    const rejected = expect(sent).rejects.toThrow('terminal_not_writable')
    await vi.advanceTimersByTimeAsync(0)

    runtime.onPtyExit('pty-prompt', 0)

    await rejected
    expect(writes).toEqual([])
  })

  it('ends the hold on cancel without writing', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait',
      signal: controller.signal
    })
    const rejected = expect(sent).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(0)

    controller.abort()
    await rejected
    runtime.onPtyData('pty-prompt', IDLE_TITLE, Date.now())
    await vi.runAllTimersAsync()
    expect(writes).toEqual([])
  })
})

describe('agent prompt writer: expectedBinding', () => {
  afterEach(() => vi.useRealTimers())

  it('writes into the admitted binding', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createRuntime()
    const { ptyId, processIncarnation } = runtime.getTerminalPromptRequestBinding(handle)

    const sent = runtime.sendTerminalAgentPrompt(handle, 'bound prompt', {
      inputKind: 'driving',
      expectedBinding: { ptyId, processIncarnation }
    })
    await vi.runAllTimersAsync()

    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(pasted(writes, 'bound prompt')).toBe(1)
  })

  it('refuses a different process before any byte', async () => {
    const { runtime, handle, writes } = await createRuntime()
    const { ptyId } = runtime.getTerminalPromptRequestBinding(handle)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'bound prompt', {
        inputKind: 'driving',
        expectedBinding: { ptyId, processIncarnation: 'an-earlier-process' }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(writes).toEqual([])
  })

  it('refuses a process replaced while the write guard runs', async () => {
    const { runtime, handle, writes } = await createRuntime()
    const admitted = runtime.getTerminalPromptRequestBinding(handle)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'bound prompt', {
        inputKind: 'driving',
        expectedBinding: {
          ptyId: admitted.ptyId,
          processIncarnation: admitted.processIncarnation
        },
        beforeWrite: () => {
          vi.spyOn(runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
            ...admitted,
            processIncarnation: 'replacement'
          })
        }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(writes).toEqual([])
  })
})
