import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => {
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
})

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', 'dsh-tui-0.17', `${name}.txt`), 'utf8')
// The bytes dsh-tui 0.17 paints as its first turn starts.
const DSH_TURN_STARTED = '\x1b]0;⠂ 🐋 \x07\x1b]7501;state=working:app=dsh-tui\x1b\\'

// #33227: dsh-tui 0.17 paints its launchpad before its session opens and refuses Enter until then,
// keeping the draft, so a launch prompt sat in the launchpad after Orca's one Enter.
describe('a dsh launch prompt whose first Enter the launchpad refused', () => {
  afterEach(() => vi.useRealTimers())

  async function launchDsh(screen: string, acceptingEnter: number) {
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
    const submission = runtime.sendTerminalAgentPrompt(handle, 'say hi in one word', {
      inputKind: 'launch',
      composerReady: true,
      acceptQueued: true,
      requestId: 'dsh-launch',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(submission).resolves.toMatchObject({ accepted: true })
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
})
