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

describe('held prompt retry follows the foreground consumer', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    { launchAgent: 'claude', foregroundAgent: 'codex', enters: 2 },
    { launchAgent: 'codex', foregroundAgent: 'claude', enters: 1 },
    { launchAgent: 'codex', foregroundAgent: 'codex', enters: 2 },
    { launchAgent: 'codex', foregroundAgent: undefined, enters: 2 },
    { launchAgent: 'claude', foregroundAgent: undefined, enters: 1 }
  ] as const)(
    '$launchAgent launch with $foregroundAgent consuming a swallowed first Enter',
    async ({ launchAgent, foregroundAgent, enters }) => {
      vi.useFakeTimers()
      let submitted = false
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data === '\r' && writes.filter((write) => write === '\r').length === 2) {
            submitted = true
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          }
        },
        launchAgent
      )
      const pty = runtime['ptysById'].get('pty-prompt')!
      pty.foregroundAgent = foregroundAgent ?? null
      Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
      Object.defineProperty(runtime, 'readCurrentTerminalWaitScreen', {
        value: async () => ({
          lines: [],
          draft: submitted ? undefined : '[Pasted Content 9250 chars]'
        })
      })
      const prompt = `first\n${'x'.repeat(9244)}`
      const submission = runtime.sendTerminalAgentPrompt(handle, prompt, {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'consumer-held-prompt',
        observationTimeoutMs: 0
      })
      await vi.runAllTimersAsync()

      await expect(submission).resolves.toMatchObject({ accepted: true })
      expect(writes[0]).toBe(
        (foregroundAgent ?? launchAgent) === 'codex'
          ? prompt.replace('\n', '\x1b\r')
          : `\x1b[200~${prompt}\x1b[201~`
      )
      expect(writes.filter((write) => write === '\r')).toHaveLength(enters)
    }
  )
})
