import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { AGENT_PROMPT_PERMISSION_RECHECK_MS } from './agent-prompt-permission-hold'

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

const PERMISSION_TITLE = '\x1b]0;Codex waiting for permission\x07'
const IDLE_TITLE = '\x1b]0;Codex idle\x07'
const WORKING_TITLE = '\x1b]0;Codex working\x07'

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
          // Approval can arrive during the async guard read, before paste.
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

  it('ends the hold on cancel without writing', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createRuntime()
    runtime.onPtyData('pty-prompt', PERMISSION_TITLE, Date.now())
    const sent = runtime.sendTerminalAgentPrompt(handle, 'held prompt', {
      inputKind: 'driving',
      onPermission: 'wait',
      observationSignal: controller.signal
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
