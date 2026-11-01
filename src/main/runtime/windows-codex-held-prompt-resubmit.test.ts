import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
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
}))

describe('a Windows Codex prompt held in its paste burst', () => {
  afterEach(() => vi.useRealTimers())

  // #11343: Windows Codex reads a paste as key events and takes an Enter that reaches it mid-burst
  // as a newline, so a dispatch sat in its composer as `[Pasted Content N chars]`.
  it.each([
    { composer: 'still holds the dispatch', draft: '[Pasted Content 9250 chars]', enters: 2 },
    { composer: 'is empty', draft: undefined, enters: 1 },
    { composer: "holds the user's own text", draft: 'also fix the readme typo', enters: 1 }
  ])(
    'presses Enter again only while a Windows Codex composer $composer',
    async ({ draft, enters }) => {
      vi.useFakeTimers()
      let submitted = false
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data !== '\r' || writes.filter((write) => write === '\r').length < 2) {
            return
          }
          submitted = true
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        },
        'codex'
      )
      Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
      Object.defineProperty(runtime, 'readCurrentTerminalWaitScreen', {
        value: async () => ({ lines: [], draft: submitted ? undefined : draft })
      })

      const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(9_250), {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'windows-codex-dispatch',
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()

      await expect(submission).resolves.toMatchObject({ accepted: true })
      expect(writes.filter((write) => write === '\r')).toHaveLength(enters)
    }
  )

  it.each([
    { change: 'the user types beside the held paste', draft: '[Pasted Content 9250 chars] and x' },
    { change: 'the held window runs out', draft: '[Pasted Content 9250 chars]', lateMs: 60_000 }
  ])('decides the Windows Codex retry again after its write guard when $change', async (c) => {
    vi.useFakeTimers()
    let draft = '[Pasted Content 9250 chars]'
    let guards = 0
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )
    Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
    Object.defineProperty(runtime, 'readCurrentTerminalWaitScreen', {
      value: async () => ({ lines: [], draft })
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(9_250), {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'windows-codex-guard',
      observationTimeoutMs: 0,
      // Paste, first Enter, then the retry's guard, which yields while the screen moves on.
      beforeWrite: async () => {
        guards += 1
        if (guards === 3) {
          draft = c.draft
          vi.setSystemTime(Date.now() + (c.lateMs ?? 0))
        }
      }
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(guards).toBe(3)
    expect(writes.filter((write) => write === '\r')).toHaveLength(1)
  })

  it('does not press Enter into a Windows Codex composer showing a rotating placeholder', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )
    Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
    // Codex 0.162 after taking a prompt: bold glyph, dim rotating placeholder, dim model footer.
    runtime.onPtyData(
      'pty-prompt',
      '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7\x1b[2mExplain this codebase\x1b[22m\r\n\r\n\x1b[2m  gpt-5.1 default · ~/repo\x1b[22m\x1b8',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(9_250), {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'windows-codex-placeholder',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect((await runtime['readCurrentTerminalWaitScreen']('pty-prompt'))?.draft).toBeUndefined()
    expect(writes.filter((write) => write === '\r')).toHaveLength(1)
  })
})
