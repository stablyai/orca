import type * as WorktreeScanCacheModule from '../../../../../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../../../../../git/worktrees/catalog/worktree-listing'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../../../../../../terminal/input/agent-prompt-submission-runtime-test-fixture'

vi.mock(
  '../../../../../../../git/worktrees/catalog/worktree-scan-cache',
  async (importOriginal) => {
    const facade = getWorktreeListingMocks()
    return {
      ...(await importOriginal<typeof WorktreeScanCacheModule>()),
      listWorktrees: facade.listWorktrees
    }
  }
)

vi.mock('../../../../../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
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
        branch: 'feature/prompt-contract',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    listWorktreesStrict: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-contract',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('orchestration worker-start prompt contract', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not attribute output from the old busy turn to a queued prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'codex')
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    const pending = runtime.sendTerminalAgentPrompt(handle, 'queued prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'busy-swallowed',
      observationTimeoutMs: 0
    })

    await vi.runAllTimersAsync()
    const send = await pending
    expect(send).toMatchObject({
      prompt: {
        requestId: 'busy-swallowed',
        stages: ['input_accepted']
      }
    })
    const observed = runtime.observeTerminalAgentPrompt(handle, send.prompt!, 1_000)
    setTimeout(() => {
      runtime.onPtyData('pty-prompt', 'old turn output', Date.now())
    }, 50)
    await vi.runAllTimersAsync()

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted']
    })
  })
})
