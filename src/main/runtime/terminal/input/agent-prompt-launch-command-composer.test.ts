import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

const { worktree } = vi.hoisted(() => ({
  worktree: {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/prompt',
    isBare: false,
    isMainWorktree: false
  }
}))

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue([worktree])
}))
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue([worktree])
}))

afterEach(() => {
  vi.useRealTimers()
})

// Claude's composer enables bracketed paste once mounted; its launch watch settles after the 1.5s quiet window.
const COMPOSER_MOUNTED = '\x1b[?2004h'
const QUIET_WINDOW_MS = 1_500
const SUBMIT_DELAY_MS = 501

const PROMPT_OPTIONS = {
  inputKind: 'driving',
  acceptQueued: true,
  requestId: 'request-1',
  leadLine: 'Lead.',
  observationTimeoutMs: 1
} as const

async function createFlaggedPane(command: string, onPaste?: (runtime: OrcaRuntimeService) => void) {
  vi.useFakeTimers()
  const enterAt: number[] = []
  const pane = await createAgentPromptSubmissionRuntime(
    (runtime, data) => {
      if (data === '\r') {
        enterAt.push(Date.now())
      }
      if (data.includes('\x1b[201~')) {
        onPaste?.(runtime)
      }
    },
    { command }
  )
  const mountComposer = (): void => {
    pane.runtime.onPtyData('pty-prompt', COMPOSER_MOUNTED, Date.now())
  }
  const send = async () => {
    const sentAt = Date.now()
    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'hello', PROMPT_OPTIONS)
    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({ accepted: true })
    return enterAt.map((at) => at - sentAt)
  }
  return { ...pane, mountComposer, send }
}

it('holds Enter for a flagged claude pane until its composer mounts and goes quiet', async () => {
  const pane = await createFlaggedPane('claude --model opus', () => {
    setTimeout(() => pane.mountComposer(), 2_000)
  })

  expect(await pane.send()).toEqual([2_000 + QUIET_WINDOW_MS + SUBMIT_DELAY_MS])
})

it('waits only the rest of the quiet window for a send after the composer mounts', async () => {
  const pane = await createFlaggedPane('claude --model opus')
  pane.mountComposer()
  await vi.advanceTimersByTimeAsync(500)

  expect(await pane.send()).toEqual([QUIET_WINDOW_MS - 500 + SUBMIT_DELAY_MS])
})

it('keeps the fixed submit delay for a ready flagged claude pane', async () => {
  const pane = await createFlaggedPane('claude --model opus')
  pane.mountComposer()
  await vi.advanceTimersByTimeAsync(5_000)

  expect(await pane.send()).toEqual([SUBMIT_DELAY_MS])
})
