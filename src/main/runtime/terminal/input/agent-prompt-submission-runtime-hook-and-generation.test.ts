import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { deliverFollowUp } from '../../../external-conversations/external-conversation-send'
import { ConversationChain } from '../../../external-conversations/external-conversation-chain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeStore } from '../../rpc/server/runtime-rpc-worktree-store-fixtures'

const createPromptRuntime = createAgentPromptSubmissionRuntime

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
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
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('agent prompt submission runtime hook and generation cases', () => {
  afterEach(() => vi.useRealTimers())

  async function createHookOnlyPromptRuntime(
    hook: {
      state: 'done' | 'working'
      stateStartedAt: number
      mainAgent?: { state: 'done' | 'working'; stateStartedAt: number }
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
          // receivedAt changes even on same-state tool pings.
          receivedAt: Date.now(),
          stateStartedAt: hook.stateStartedAt,
          ...(hook.mainAgent ? { mainAgent: { ...hook.mainAgent } } : {})
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

  // Child work holds the row working across the prompt; only the main agent's turn start moves.
  it('settles a prompt whose turn starts while child work keeps the row working', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mainAgent: { state: 'done' | 'working'; stateStartedAt: number } = {
      state: 'done',
      stateStartedAt: 800
    }
    const hook = { state: 'working' as const, stateStartedAt: 500, mainAgent }
    const { runtime, handle, writes } = await createHookOnlyPromptRuntime(hook, 'codex')
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          vi.setSystemTime(3_000)
          hook.mainAgent = { state: 'working', stateStartedAt: 3_000 }
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'held-open-turn',
      observationTimeoutMs: 20_000
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted', 'turn_started'] }
    })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it.each([false, true])(
    'reserves a hook-only turn start for the oldest live prompt (replace controller: %s)',
    async (replaceController) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      const hook = { state: 'working' as const, stateStartedAt: 1_000 }
      const { runtime, handle, writes } = await createHookOnlyPromptRuntime(hook, 'codex')
      let answer = false
      const controller = {
        spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
        write: (_ptyId: string, data: string) => {
          writes.push(data)
          if (data === '\r' && answer) {
            hook.stateStartedAt = Date.now()
          }
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      }
      runtime.setPtyController(controller)
      const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'hook-queued-first',
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()
      const first = await firstPromise
      expect(first.prompt?.stages).toEqual(['input_accepted'])
      if (replaceController) {
        runtime.setPtyController({ ...controller })
      }
      const firstObserved = runtime.observeTerminalAgentPrompt(handle, first.prompt!, 20_000)
      answer = true
      const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'hook-queued-second',
        observationTimeoutMs: 500
      })
      await vi.runAllTimersAsync()
      await expect(firstObserved).resolves.toMatchObject({
        stages: replaceController ? ['input_accepted'] : ['input_accepted', 'turn_started']
      })
      const second = await secondPromise
      expect(second).toMatchObject({
        prompt: {
          stages: replaceController ? ['input_accepted', 'turn_started'] : ['input_accepted']
        }
      })
      if (!replaceController) {
        const secondObserved = runtime.observeTerminalAgentPrompt(handle, second.prompt!, 1_000)
        hook.stateStartedAt += 1
        await vi.advanceTimersByTimeAsync(50)
        await expect(secondObserved).resolves.toMatchObject({
          stages: ['input_accepted', 'turn_started']
        })
      }
    }
  )

  it('does not write Enter after the PTY generation changes during settlement', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
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

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
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

    const first = runtime.sendTerminalAgentPrompt(handle, 'first prompt', { inputKind: 'driving' })
    const second = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      inputKind: 'driving'
    })
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

  it.each(['reset', 'exit'] as const)('retires pending %s', async (retirement) => {
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
      inputKind: 'driving',
      beforeWrite: async () => {
        firstWriteReached()
        await firstGate
      }
    })
    const obsolete = expect(first).rejects.toThrow('terminal_handle_stale')
    await firstWrite
    if (retirement === 'exit') {
      runtime.onPtyExit('pty-prompt', 0)
    } else {
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-prompt',
        { value: 0, generation: 'reset' },
        0
      )
    }

    await obsolete
    if (retirement === 'exit') {
      releaseFirst()
      return
    }
    const replacement = runtime.sendTerminalAgentPrompt(handle, 'replacement prompt', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()
    await expect(replacement).resolves.toMatchObject({ accepted: true })
    expect(writes.some((data) => data.includes('replacement prompt'))).toBe(true)

    releaseFirst()
  })

  it.each(['generation', 'signal'] as const)('suffix stop %s', async (stop) => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0
    const controller = new AbortController()

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      inputKind: 'driving',
      signal: controller.signal,
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2 && stop === 'signal') {
          return controller.abort()
        }
        if (writeChecks === 2) {
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      }
    })

    await expect(submission).rejects.toThrow(
      stop === 'signal' ? 'request_aborted' : 'terminal_handle_stale'
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
  })

  it.each(['agent', 'reject'] as const)('follow-up cancel before late %s', async (late) => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    const probe = Promise.withResolvers<'agent'>(),
      reached = Promise.withResolvers<void>()
    const unsubscribe = vi.fn()
    vi.spyOn(runtime, 'subscribeToTerminalData').mockReturnValue(unsubscribe)
    vi.mocked(runtime.readLaunchedAgentForeground).mockImplementation(() => {
      reached.resolve()
      return probe.promise
    })
    const chain = new ConversationChain(new AbortController().signal)
    const delivered = chain.enqueue('prompt', (signal) =>
      deliverFollowUp(runtime, {
        handle,
        agent: 'claude',
        expectedBinding: runtime.getTerminalPromptRequestBinding(handle),
        text: 'follow-up',
        requestId: 'follow-up',
        signal
      })
    )
    await reached.promise
    void chain.cancel('prompt', 'conversation_cancelled')
    await expect(delivered).resolves.toMatchObject({ outcome: 'refused' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    if (late === 'agent') {
      probe.resolve('agent')
    } else {
      probe.reject(new Error('late failure'))
    }
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
  })
})
