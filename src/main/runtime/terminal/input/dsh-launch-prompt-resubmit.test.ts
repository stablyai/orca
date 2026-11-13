import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { dispatchPreambleSendOptions } from '../../orchestration/workers/launch/worker-dispatch-preamble'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-verification',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', '__fixtures__', 'dsh-tui-0.17', `${name}.txt`), 'utf8')
// The bytes dsh-tui 0.17 paints as its first turn starts.
const DSH_TURN_STARTED = '\x1b]0;⠂ 🐋 \x07\x1b]7501;state=working:app=dsh-tui\x1b\\'

// dsh-tui 0.17 paints a launchpad before the session accepts Enter, retaining drafts after the first submission (#33227).
describe('a dsh launch prompt whose first Enter the launchpad refused', () => {
  afterEach(() => vi.useRealTimers())

  async function launchDsh(
    screen: string,
    acceptingEnter: number,
    dispatch = false,
    afterSendMs = 0
  ) {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        const enters = writes.filter((write) => write === '\r').length
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', screen, Date.now())
        } else if (data === '\r' && enters === acceptingEnter) {
          runtime.onPtyData('pty-prompt', DSH_TURN_STARTED, Date.now())
        }
      },
      'dsh'
    )
    // The captures were painted on a 120x40 grid.
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
    const submission = runtime.sendTerminalAgentPrompt(
      handle,
      'say hi in one word',
      dispatch
        ? dispatchPreambleSendOptions('dsh-dispatch')
        : {
            inputKind: 'launch',
            composerReady: true,
            acceptQueued: true,
            requestId: 'dsh-launch',
            observationTimeoutMs: 0
          }
    )
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(submission).resolves.toMatchObject({ accepted: true })
    await vi.advanceTimersByTimeAsync(afterSendMs)
    return {
      enters: writes.filter((write) => write === '\r').length,
      pastes: writes.filter((write) => write.includes(AGENT_PROMPT_BRACKETED_PASTE_END)).length
    }
  }

  it('presses only Enter again until the session opens and the turn starts', async () => {
    await expect(launchDsh(fixture('launchpad-draft-starting'), 3)).resolves.toEqual({
      enters: 3,
      pastes: 1
    })
  })

  it('never presses Enter into the first-run guide that covers the launchpad', async () => {
    await expect(launchDsh(fixture('first-run-guide'), Infinity)).resolves.toEqual({
      enters: 1,
      pastes: 1
    })
  })

  it('stops once the launchpad no longer holds the prompt', async () => {
    await expect(launchDsh(fixture('launchpad-empty'), Infinity)).resolves.toEqual({
      enters: 1,
      pastes: 1
    })
  })

  // #33499: a loaded host can open dsh's session after the send's 30 s budget has returned.
  it('keeps pressing Enter after the send returns until a slow session opens', async () => {
    await expect(
      launchDsh(fixture('launchpad-draft-starting'), 45, false, 30_000)
    ).resolves.toEqual({ enters: 45, pastes: 1 })
  })

  it('keeps pressing Enter for a worker dispatch whose session opens late', async () => {
    await expect(launchDsh(fixture('launchpad-draft-starting'), 45, true, 30_000)).resolves.toEqual(
      { enters: 45, pastes: 1 }
    )
  })

  it('stops pressing Enter once someone else types into the pane', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', fixture('launchpad-draft-starting'), Date.now())
        }
      },
      'dsh'
    )
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
    const enters = (): number => writes.filter((write) => write === '\r').length
    const submission = runtime.sendTerminalAgentPrompt(handle, 'say hi in one word', {
      inputKind: 'launch',
      composerReady: true,
      acceptQueued: true,
      requestId: 'dsh-launch',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(submission).resolves.toMatchObject({ accepted: true })
    const beforeTyping = enters()
    runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'x')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(beforeTyping).toBeGreaterThan(30)
    expect(enters()).toBe(beforeTyping)
  })

  // #30778: a fresh worker's tui-idle settles on dsh 0.17's boot `OSC 7501 idle`, before its session opens.
  it('presses Enter again for a worker dispatch the launchpad refused', async () => {
    await expect(launchDsh(fixture('launchpad-draft-starting'), 3, true)).resolves.toEqual({
      enters: 3,
      pastes: 1
    })
  })
})
