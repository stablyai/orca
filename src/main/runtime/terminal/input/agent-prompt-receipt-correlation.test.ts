import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

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
        branch: 'feature/prompt-correlation',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    listWorktreesStrict: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-correlation',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('agent prompt receipt correlation', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    'after-timeout',
    'during-submit',
    'boundary-gap',
    'gap-start',
    'gap-finish',
    'gap-finish-again',
    'pending-after-stall',
    'cancelled-pending',
    'same-pending',
    'gap-unknown'
  ] as const)(
    'does not let a predecessor receipt claim the replacement turn (%s)',
    async (replacement) => {
      vi.useFakeTimers()
      const whileSubmitting = replacement !== 'after-timeout'
      let replaceOnSubmit = whileSubmitting
      let answerOnSubmit = false
      let endQuestionOnSubmit = replacement === 'gap-finish-again'
      const boundary = '\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;Codex idle\x07'
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data !== '\r') {
            return
          }
          if (replaceOnSubmit) {
            replaceOnSubmit = false
            if (replacement === 'boundary-gap') {
              runtime.onPtyData('pty-prompt', boundary, Date.now())
              runtime.notePtyDataGap('pty-prompt')
              runtime.onPtyData('pty-prompt', 'ordinary suffix', Date.now())
            } else if (replacement.startsWith('gap-')) {
              runtime.notePtyDataGap('pty-prompt')
              const suffix =
                replacement === 'gap-finish' || replacement === 'gap-finish-again'
                  ? '\x1b]133;D;0\x07'
                  : replacement === 'gap-start'
                    ? '\x1b]133;C\x07'
                    : ''
              runtime.onPtyData('pty-prompt', suffix, Date.now())
              runtime.onPtyData('pty-prompt', 'ordinary suffix', Date.now())
            } else if (replacement === 'cancelled-pending') {
              runtime.onPtyData('pty-prompt', '\x1b]133;D;0\x07\x1b]133;C\x07', Date.now())
            } else if (replacement === 'same-pending') {
              runtime.onPtyData('pty-prompt', 'agent output', Date.now())
              runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
            } else if (replacement !== 'pending-after-stall') {
              runtime.onPtyData('pty-prompt', boundary, Date.now())
            }
          } else if (answerOnSubmit) {
            if (endQuestionOnSubmit) {
              endQuestionOnSubmit = false
              runtime.onPtyData('pty-prompt', '\x1b]133;D;0\x07', Date.now())
            }
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          }
        },
        'codex',
        undefined,
        undefined,
        { getForegroundProcess: async () => 'codex' }
      )
      runtime.onPtyData('pty-prompt', '\x1b]133;C\x07\x1b]0;Codex working\x07', Date.now())
      if (
        replacement === 'same-pending' ||
        replacement === 'cancelled-pending' ||
        replacement === 'pending-after-stall'
      ) {
        runtime.onPtyData('pty-prompt', '\x1b]133;B\x07\x1b]133;C\x07', Date.now())
      }
      const exit = runtime.sendTerminalAgentPrompt(handle, 'exit', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'predecessor-exit',
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()
      const predecessor = await exit
      expect(predecessor.prompt?.stages).toEqual(
        replacement === 'same-pending' ? ['input_accepted', 'turn_started'] : ['input_accepted']
      )
      if (replacement === 'pending-after-stall') {
        runtime.onPtyData('pty-prompt', 'agent output\x1b]0;Codex working\x07', Date.now())
        await expect(
          runtime.observeTerminalAgentPrompt(handle, predecessor.prompt!, 0)
        ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
        return
      }
      if (replacement === 'gap-unknown') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        await expect(
          runtime.observeTerminalAgentPrompt(handle, predecessor.prompt!, 0)
        ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
        return
      }
      if (replacement === 'after-timeout') {
        runtime.onPtyData('pty-prompt', boundary, Date.now())
      }
      expect(await runtime.isTerminalRunningSettledPromptAgent(handle)).toBe(true)
      if (replacement === 'same-pending') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
      answerOnSubmit = true
      const question = runtime.sendTerminalAgentPrompt(handle, 'answer in the new agent', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'replacement-question',
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()
      const current = await question
      expect(current.prompt?.generation).toBe(predecessor.prompt?.generation)
      expect(current.prompt?.processIncarnation).toBe(predecessor.prompt?.processIncarnation)
      expect(current.prompt?.stages).toEqual(
        replacement === 'gap-finish-again' ? ['input_accepted'] : ['input_accepted', 'turn_started']
      )
      if (replacement === 'gap-finish-again') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
        expect(await runtime.isTerminalRunningSettledPromptAgent(handle)).toBe(true)
        const next = runtime.sendTerminalAgentPrompt(handle, 'fresh after repeated exit', {
          inputKind: 'driving',
          acceptQueued: true,
          requestId: 'after-repeated-exit',
          observationTimeoutMs: 0
        })
        await vi.runAllTimersAsync()
        expect((await next).prompt?.stages).toEqual(['input_accepted', 'turn_started'])
      }
      const acceptedWrites = writes.length
      await expect(
        runtime.observeTerminalAgentPrompt(handle, predecessor.prompt!, 0)
      ).resolves.toMatchObject({
        stages:
          replacement === 'same-pending' ? ['input_accepted', 'turn_started'] : ['input_accepted']
      })
      expect(writes).toHaveLength(acceptedWrites)
    }
  )

  it('keeps retained claims with their original operation when a public request id is reused', async () => {
    vi.useFakeTimers()
    let answer = true
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r' && answer) {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      },
      'codex',
      undefined,
      undefined,
      { getForegroundProcess: async () => 'codex' }
    )
    const send = async (requestId: string) => {
      const result = runtime.sendTerminalAgentPrompt(handle, 'prompt', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId,
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()
      return (await result).prompt!
    }
    expect((await send('reused')).stages).toEqual(['input_accepted', 'turn_started'])
    answer = false
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;Codex idle\x07',
      Date.now()
    )
    expect(await runtime.isTerminalRunningSettledPromptAgent(handle)).toBe(true)
    const reused = await send('reused')
    const following = await send('following')
    expect(reused).toMatchObject({
      provider: 'codex',
      observation: 'supported',
      stages: ['input_accepted']
    })
    expect(following).toMatchObject({
      provider: 'codex',
      observation: 'supported',
      stages: ['input_accepted'],
      baselineWorkingSequence: reused.baselineWorkingSequence,
      baselineExplicitWorkingStartedAt: reused.baselineExplicitWorkingStartedAt
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    await expect(runtime.observeTerminalAgentPrompt(handle, reused, 0)).resolves.toMatchObject({
      stages: ['input_accepted', 'turn_started']
    })
    await expect(runtime.observeTerminalAgentPrompt(handle, following, 0)).resolves.toMatchObject({
      stages: ['input_accepted']
    })
  })

  it('assigns historical lifecycle edges to queued receipts in FIFO order', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())

    const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'historical-first',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'historical-second',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const second = await secondPromise

    runtime.onPtyData(
      'pty-prompt',
      '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07' +
        '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07',
      Date.now()
    )

    const writesAfterSubmission = writes.length
    await expect(
      runtime.observeTerminalAgentPrompt(handle, second.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    await expect(
      runtime.observeTerminalAgentPrompt(handle, first.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    expect(writes).toHaveLength(writesAfterSubmission)
  })
})
