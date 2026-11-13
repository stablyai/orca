import { describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import '../../../shared/orca-dispatch-status-prompt'
import { OrcaRuntimeService } from '../orca-runtime'
import './runtime-test-module-registration.spec'
import { acknowledgeAgentPromptSubmit } from '../orca-runtime-test-mocks/setup.spec'
import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('blocks tui-idle when a newer prompt follows a stale prompt and ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        'Hooks need review\n',
        'Press enter to confirm\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'agent-hooks-review-prompt'
    })
  })

  it.each(['claude', 'codex'] as const)(
    'waits for %s composer output frames to settle before one submit',
    async (agent) => {
      vi.useFakeTimers()
      try {
        const writes: string[] = []
        let composerReady = false
        let prematureEnters = 0
        let submissions = 0
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
          write: (_ptyId, data) => {
            writes.push(data)
            if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'partial redraw without cursor', Date.now())
              }, 650)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '\x1b[?2', Date.now())
              }, 750)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', '5h intermediate frame', Date.now())
              }, 751)
              setTimeout(() => {
                runtime.onPtyData('pty-bg', 'continued composer render', Date.now())
              }, 900)
              setTimeout(() => {
                composerReady = true
                runtime.onPtyData('pty-bg', 'final composer frame', Date.now())
              }, 1_000)
            }
            if (data === '\r') {
              if (composerReady) {
                submissions += 1
              } else {
                prematureEnters += 1
              }
              acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
            }
            return true
          },
          kill: () => true,
          getForegroundProcess: async () => null
        })
        const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
          launchAgent: agent
        })
        const assertAuthority = vi.fn()

        const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
          inputKind: 'driving',
          beforeWrite: assertAuthority
        })
        await vi.advanceTimersByTimeAsync(500)

        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(150)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(101)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1_748)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(1)
        await sendPromise
        expect(prematureEnters).toBe(0)
        expect(submissions).toBe(1)
        expect(writes.filter((data) => data === '\r')).toHaveLength(1)
        expect(assertAuthority).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
