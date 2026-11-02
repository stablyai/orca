import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { deliverGeneratedTerminalInput } from './generated-terminal-input-delivery'
import { finalReplayFrame } from '../../agent-transcript-replay-test-harness'

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

  it('settles a queued operation at its own deadline while the head still holds the queue', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime.onPtyData('pty-prompt', DIALOG, 0)
    const head = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'first',
      submit: true,
      agent: 'claude',
      timeoutMs: 3_000
    })
    let headSettled = false
    void head.then(() => {
      headSettled = true
    })
    const queued = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'second',
      submit: true,
      agent: 'claude',
      timeoutMs: 30
    })
    // Retired at its own budget, not when the dialog-held head finally gives up.
    expect(queued).toBe('not-sent')
    expect(headSettled).toBe(false)
    // The head's late end drains the queued run, which finds its deadline passed and writes nothing.
    runtime.onPtyData('pty-prompt', `\x1b[2J\x1b[H${READY}`, 0)
    await expect(head).resolves.toBe('delivered')
    expect(writes.some((data) => data.includes('second'))).toBe(false)
  })

  it.each(['never answers', 'answers after the deadline'])(
    'writes nothing when the final foreground read %s',
    async (variant) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      runtime.onPtyData('pty-prompt', READY, 0)
      const controller = (
        runtime as unknown as { ptyController: { getForegroundProcess: () => Promise<string> } }
      ).ptyController
      controller.getForegroundProcess = () =>
        new Promise((resolve) => {
          if (variant !== 'never answers') {
            setTimeout(() => resolve('claude'), 120)
          }
        })
      const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
        text: 'late',
        submit: true,
        agent: 'claude',
        timeoutMs: 60
      })
      expect(outcome).toBe('not-sent')
      await new Promise((resolve) => setImmediate(resolve))
      expect(writes).toEqual([])
    }
  )

  // Cline runs under node with no turn settlement; its recorded approval prompt must keep its keys.
  it('never types a prompt into Cline at its recorded "Approve tool call?" prompt', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'cline')
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
    const recorded = readFileSync(
      join(__dirname, '../../__fixtures__/cline-3-0-66-permission.txt'),
      'utf8'
    )
    runtime.onPtyData('pty-prompt', recorded, 0)
    const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'yes',
      submit: true,
      agent: 'cline',
      timeoutMs: 300
    })
    expect(outcome).toBe('not-sent')
    expect(writes).toEqual([])
  })

  // A late observer of an idle Codex or OpenCode has only the current grid and modes: no startup
  // byte that a scanner could read.
  it.each([
    ['codex', 'codex-0157-plain-ready', 'startup'],
    ['codex', 'codex-0157-plain-ready', 'running'],
    ['opencode2', 'opencode-2-0-21-timed-cold-standalone', 'startup'],
    ['opencode2', 'opencode-2-0-21-timed-cold-standalone', 'running']
  ] as const)(
    'stages a draft into a recorded idle %s grid with empty replay (%s, %s)',
    async (agent, fixture, intent) => {
      const { ruledScreenLines: lines } = await finalReplayFrame(fixture, 120, 40)
      vi.useFakeTimers()
      vi.setSystemTime(10_000)
      try {
        const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
          () => {},
          agent
        )
        if (agent === 'opencode2') {
          runtime.onPtyData('pty-prompt', '\x1b[?1049h\x1b[?2004h', 0)
        }
        vi.spyOn(
          runtime as unknown as { readGeneratedInputScreen: () => Promise<unknown> },
          'readGeneratedInputScreen'
        ).mockResolvedValue({ lines, alternateScreen: agent === 'opencode2' })
        const result = deliverGeneratedTerminalInput(runtime, handle, {
          text: 'late followup',
          submit: false,
          agent,
          intent,
          timeoutMs: 3_000
        })
        await vi.advanceTimersByTimeAsync(3_100)
        await expect(result).resolves.toBe('staged')
        expect(writes).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
