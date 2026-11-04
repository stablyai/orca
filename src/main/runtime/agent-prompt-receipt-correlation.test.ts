import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
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
