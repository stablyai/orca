import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const createPromptRuntime = createAgentPromptSubmissionRuntime

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

describe('agent prompt submission runtime hook and generation cases', () => {
  afterEach(() => vi.useRealTimers())

  async function createHookOnlyPromptRuntime(
    hook: {
      state: 'done' | 'working'
      stateStartedAt: number
    },
    launchAgent: 'antigravity' | 'kimi' | 'codex' = 'kimi'
  ): Promise<{
    runtime: OrcaRuntimeService
    handle: string
    writes: string[]
  }> {
    let handle = ''
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'prompt-pane',
          terminalHandle: handle,
          state: hook.state,
          prompt: '',
          agentType: launchAgent,
          connectionId: null,
          // Why: every hook ping refreshes receivedAt, including same-state tool pings.
          receivedAt: Date.now(),
          stateStartedAt: hook.stateStartedAt
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    handle = (
      await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
        launchAgent
      })
    ).handle
    return { runtime, handle, writes }
  }

  it('accepts a hook working status with no window and no title coverage', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook = { state: 'done' as 'done' | 'working', stateStartedAt: 1_000 }
    const { runtime, handle, writes } = await createHookOnlyPromptRuntime(hook)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          vi.setSystemTime(3_000)
          hook.state = 'working'
          hook.stateStartedAt = 3_000
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('settles an Antigravity prompt when PreInvocation starts a new hook turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook = { state: 'done' as 'done' | 'working', stateStartedAt: 1_000 }
    const { runtime, handle, writes } = await createHookOnlyPromptRuntime(hook, 'antigravity')
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          vi.setSystemTime(3_000)
          hook.state = 'working'
          hook.stateStartedAt = 3_000
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      acceptQueued: true,
      requestId: 'antigravity-pre-invocation',
      observationTimeoutMs: 20_000
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: {
        provider: 'antigravity',
        observation: 'supported',
        stages: ['input_accepted', 'turn_started']
      }
    })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  // Why: same-state pings keep refreshing receivedAt on a turn that started before the prompt;
  // only the pinned stateStartedAt separates that from a turn this prompt started.
  it('does not accept a hook row refreshed without a new working turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createHookOnlyPromptRuntime({
      state: 'working',
      stateStartedAt: 1_000
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('reserves a hook-only turn start for the oldest queued prompt receipt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook = { state: 'working' as const, stateStartedAt: 1_000 }
    const { runtime, handle, writes } = await createHookOnlyPromptRuntime(hook, 'codex')

    const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
      acceptQueued: true,
      requestId: 'hook-queued-first',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const first = await firstPromise
    expect(first.prompt?.stages).toEqual(['input_accepted'])

    const firstObserved = runtime.observeTerminalAgentPrompt(handle, first.prompt!, 20_000)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          hook.stateStartedAt = Date.now()
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      acceptQueued: true,
      requestId: 'hook-queued-second',
      observationTimeoutMs: 500
    })
    await vi.runAllTimersAsync()

    await expect(firstObserved).resolves.toMatchObject({
      stages: ['input_accepted', 'turn_started']
    })
    const second = await secondPromise
    expect(second).toMatchObject({
      prompt: { stages: ['input_accepted'] }
    })

    const secondObserved = runtime.observeTerminalAgentPrompt(handle, second.prompt!, 1_000)
    hook.stateStartedAt += 1
    await vi.advanceTimersByTimeAsync(50)

    await expect(secondObserved).resolves.toMatchObject({
      stages: ['input_accepted', 'turn_started']
    })
  })

  it('does not write Enter after the PTY generation changes during settlement', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('terminal_handle_stale')

    await vi.advanceTimersByTimeAsync(0)
    expect(writes.some((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toBe(true)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      runtime.getPtyOutputSequence('pty-prompt')
    )
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not reuse explicit permission status across a provider generation reset', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"waiting","agentType":"aider"}\x07',
      Date.now()
    )
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(0)

    expect(writes.some((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))).toBe(true)
    controller.abort()
    await vi.runAllTimersAsync()
    await rejected
  })

  it('does not reuse output-only permission across a provider generation reset', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    const sequenceAtSpawnStart = runtime.getPtyOutputSequence('pty-prompt')
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      sequenceAtSpawnStart
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('fails closed when new bytes race a reset after old permission output', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'continued' },
      0
    )
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    const sequenceAtSpawnStart = runtime.getPtyOutputSequence('pty-prompt')
    runtime.onPtyData('pty-prompt', 'replacement startup output\n', Date.now())
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      sequenceAtSpawnStart
    )

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_blocked'
    )
    expect(writes).toEqual([])
  })

  it('reports permission reached after the first Enter as blocked', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('serializes concurrent prompt submissions within one PTY generation', async () => {
    vi.useFakeTimers()
    let enterCount = 0
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        enterCount += 1
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })

    const first = runtime.sendTerminalAgentPrompt(handle, 'first prompt')
    const second = runtime.sendTerminalAgentPrompt(handle, 'second prompt')
    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    const firstPaste = writes.findIndex((data) => data.includes('first prompt'))
    const firstEnter = writes.indexOf('\r', firstPaste + 1)
    const secondPaste = writes.findIndex((data) => data.includes('second prompt'))
    const secondEnter = writes.indexOf('\r', secondPaste + 1)
    expect(firstPaste).toBeGreaterThanOrEqual(0)
    expect(firstEnter).toBeGreaterThan(firstPaste)
    expect(secondPaste).toBeGreaterThan(firstEnter)
    expect(secondEnter).toBeGreaterThan(secondPaste)
    expect(enterCount).toBe(2)
  })

  it('reserves a lifecycle transition for only one queued prompt receipt', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'codex')
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())

    const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
      acceptQueued: true,
      requestId: 'queued-first',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      acceptQueued: true,
      requestId: 'queued-second',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const second = await secondPromise

    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07', Date.now())
    const firstObserved = runtime.observeTerminalAgentPrompt(handle, first.prompt!, 1_000)
    await vi.runAllTimersAsync()
    const secondObserved = runtime.observeTerminalAgentPrompt(handle, second.prompt!, 1_000)
    await vi.runAllTimersAsync()

    await expect(firstObserved).resolves.toMatchObject({
      stages: ['input_accepted', 'turn_started']
    })
    await expect(secondObserved).resolves.toMatchObject({
      stages: ['input_accepted']
    })
  })

  it('does not queue a replacement generation behind an obsolete submission', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let firstWriteReached!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteReached = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })

    const first = runtime.sendTerminalAgentPrompt(handle, 'obsolete prompt', {
      beforeWrite: async () => {
        firstWriteReached()
        await firstGate
      }
    })
    await firstWrite
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )

    const replacement = runtime.sendTerminalAgentPrompt(handle, 'replacement prompt')
    await vi.runAllTimersAsync()
    await expect(replacement).resolves.toMatchObject({ accepted: true })
    expect(writes.some((data) => data.includes('replacement prompt'))).toBe(true)

    releaseFirst()
    await expect(first).rejects.toThrow('terminal_handle_stale')
  })

  it('does not close a partial paste after the PTY generation changes', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      }
    })

    await expect(submission).rejects.toThrow('terminal_handle_stale')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
  })

  it('does not send delayed Enter after cancellation during settlement', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
  })

  it('does not send another Enter after cancellation during verification', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    // Why compute it: the submit delay now follows the payload size and the executing host,
    // so a hardcoded number aborts before the Enter on some lanes.
    await vi.advanceTimersByTimeAsync(
      getAgentPromptSubmitDelayMs(
        process.platform,
        Buffer.byteLength(buildAgentPromptPasteBytes('review this'), 'utf8')
      )
    )
    // Why: pin the phase boundary so drift fails here instead of as an empty post-abort array.
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })
})
