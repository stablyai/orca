import { describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { deliverGeneratedTerminalInput } from './generated-terminal-input-delivery'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ])
}))

const READY = '\x1b[?2004h\x1b[?2031h❯ '
const DIALOG =
  '\x1b[2J\x1b[HBypass Permissions\r\n❯ 1. No, exit\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel'

describe('one host transaction for generated input', () => {
  it('withholds Enter when a dialog takes input after the text was written, and never resends', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (current, data) => {
        if (data.includes('exact prompt')) {
          current.onPtyData('pty-prompt', DIALOG, 0)
        }
      },
      'claude'
    )
    runtime.onPtyData('pty-prompt', READY, 0)
    const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'exact prompt',
      submit: true,
      agent: 'claude'
    })
    expect(outcome).toBe('unconfirmed')
    expect(writes.filter((data) => data.includes('exact prompt'))).toHaveLength(1)
    expect(writes).not.toContain('\r')
  })

  it('spends queue residency from the same deadline and retires a queued write without a byte', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime.onPtyData('pty-prompt', DIALOG, 0)
    // The head waits at the dialog; the second expires while queued behind it.
    const head = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'first',
      submit: true,
      agent: 'claude',
      timeoutMs: 300
    })
    const queued = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'second',
      submit: true,
      agent: 'claude',
      timeoutMs: 50
    })
    // The dialog is answered the moment the head gives up: a budget restarted at the queue head
    // would now admit the second prompt.
    void head.then(() => runtime.onPtyData('pty-prompt', `\x1b[2J\x1b[H${READY}`, 0))
    await expect(head).resolves.toBe('not-sent')
    await expect(queued).resolves.toBe('not-sent')
    expect(writes).toEqual([])
  })
})
