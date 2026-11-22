import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  getTerminalPasteIngestMs
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { deliverTerminalAgentLaunchPrompt } from '../../rpc/methods/agent-launch/agent-launch-terminal-prompt'

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

const capture = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', '__fixtures__', `opencode-2-3-2-${name}.txt`), 'utf8')
// The 83-line brief pasted for the capture.
const BRIEF = Array.from(
  { length: 83 },
  (_, line) => `Line ${line + 1}: implement the requested brief item number ${line + 1}.`
).join('\n')

const countEnters = (writes: readonly string[]): number =>
  writes.filter((write) => write === '\r').length

type OpenCodeBoot = { before?: string; prompt?: string }

const BUSY = '\x1b]7501;state=working:app=opencode\x1b\\'

// OpenCode inserts a paste asynchronously, so an Enter that beats it leaves [Pasted ~N lines] unsent (#45760).
describe('an OpenCode launch prompt whose first Enter did not submit', () => {
  afterEach(() => vi.useRealTimers())

  // `onEnter` returns the frame OpenCode paints for the nth Enter, if any.
  async function bootOpenCode(
    onEnter: (enter: number) => string | undefined,
    { before = '', prompt = BRIEF }: OpenCodeBoot = {}
  ): ReturnType<typeof createAgentPromptSubmissionRuntime> {
    vi.useFakeTimers()
    const fixture = await createAgentPromptSubmissionRuntime((runtime, data) => {
      const frame = data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)
        ? prompt === BRIEF
          ? capture('paste-held')
          : undefined
        : data === '\r'
          ? onEnter(countEnters(fixture.writes))
          : undefined
      if (frame) {
        runtime.onPtyData('pty-prompt', frame, Date.now())
      }
    }, 'opencode2')
    // The capture was painted on a 120x40 grid.
    vi.spyOn(fixture.runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
    fixture.runtime.onPtyData('pty-prompt', capture('boot') + before, Date.now())
    return fixture
  }

  async function launchOpenCode(
    onEnter: (enter: number) => string | undefined,
    boot: OpenCodeBoot = {}
  ): Promise<{ enters: number; settledMs: number; retries: number; retrySettledMs: number }> {
    const { prompt = BRIEF } = boot
    const { runtime, handle, writes } = await bootOpenCode(onEnter, boot)
    const startedAt = Date.now()
    let settledAt = Number.NaN
    let retrySettledAt = Number.NaN
    let retries = 0
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt, {
      inputKind: 'launch',
      composerReady: true,
      acceptQueued: true,
      requestId: 'opencode-launch',
      observationTimeoutMs: 0,
      onHeldPromptRetry: (retry) => {
        retries += 1
        void retry.then(() => (retrySettledAt = Date.now()))
      }
    })
    void submission.then(() => (settledAt = Date.now()))
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(submission).resolves.toMatchObject({ accepted: true })
    return {
      enters: countEnters(writes),
      settledMs: settledAt - startedAt,
      retries,
      retrySettledMs: retrySettledAt - startedAt
    }
  }

  // The send resolves once its first Enter is written, as it does for every other agent.
  const ACCEPTED_MS =
    AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS +
    getTerminalPasteIngestMs(
      process.platform,
      Buffer.byteLength(wrapTerminalBracketedPasteText(BRIEF))
    )

  it('presses Enter again through the launch write guard after the launch resolves', async () => {
    const { runtime, handle, writes } = await bootOpenCode((enter) =>
      enter === 2 ? capture('submitted') : undefined
    )
    let enteredWhenDelivered = Number.NaN
    const delivery = deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent: 'opencode2',
      freshLaunch: true,
      text: BRIEF
    }).then((delivered) => {
      enteredWhenDelivered = countEnters(writes)
      return delivered
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(delivery).resolves.toBe(true)
    expect(enteredWhenDelivered).toBe(1)
    expect(countEnters(writes)).toBe(2)
  })

  it('presses Enter again while the composer still holds the paste', async () => {
    const result = await launchOpenCode((enter) => (enter === 2 ? capture('submitted') : undefined))
    expect(result).toMatchObject({ enters: 2, settledMs: ACCEPTED_MS, retries: 1 })
    expect(result.retrySettledMs).toBeLessThan(1500)
  })

  it('never presses Enter again once OpenCode took the prompt', async () => {
    const result = await launchOpenCode(() => capture('submitted'))
    expect(result).toMatchObject({ enters: 1, settledMs: ACCEPTED_MS })
    expect(result.retrySettledMs).toBeLessThan(500)
  })

  it('stops at the first recheck when the composer cleared without a turn start', async () => {
    const result = await launchOpenCode(() =>
      capture('submitted').replaceAll('state=working', 'state=idle')
    )
    expect(result).toMatchObject({ enters: 1, settledMs: ACCEPTED_MS })
    expect(result.retrySettledMs).toBeLessThan(1500)
  })

  it('retries once while OpenCode keeps refusing the paste', async () => {
    const result = await launchOpenCode(() => undefined)
    expect(result).toMatchObject({ enters: 2, settledMs: ACCEPTED_MS })
    expect(result.retrySettledMs).toBeLessThan(2500)
  })

  it('does not wait on a busy OpenCode, which takes a send with no new turn start', async () => {
    const result = await launchOpenCode(() => undefined, { before: BUSY })
    expect(result).toMatchObject({ enters: 1, settledMs: ACCEPTED_MS, retries: 0 })
  })

  it('sends a short prompt, which OpenCode does not collapse, exactly as before', async () => {
    const prompt = 'Fix the failing test in the readme.'
    const result = await launchOpenCode(() => undefined, { prompt })
    expect(result).toMatchObject({
      enters: 1,
      settledMs:
        AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS +
        getTerminalPasteIngestMs(
          process.platform,
          Buffer.byteLength(wrapTerminalBracketedPasteText(prompt))
        ),
      retries: 0
    })
  })
})
