import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import { OrcaRuntimeService } from '../orca-runtime'
import { acknowledgeAgentPromptSubmit } from '../orca-runtime-test-mocks/setup.spec'
import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

// Match desktop paste: submit Enter one turn after paste, without waiting for render quiescence.
async function launchedAgentPane(agent: 'claude' | 'codex' | 'qwen-code', startsTurn = true) {
  const writes: { data: string; at: number }[] = []
  const runtime = new OrcaRuntimeService(store)
  const startedAt = Date.now()
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
    write: (_ptyId, data) => {
      writes.push({ data, at: Date.now() - startedAt })
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        // Claude can repaint indefinitely after paste.
        runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now())
        for (let delay = 500; delay <= 9_000; delay += 500) {
          setTimeout(() => runtime.onPtyData('pty-bg', `frame ${delay}`, Date.now()), delay)
        }
      }
      if (startsTurn) {
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
  return { runtime, handle, writes }
}

describe('a launch prompt into a composer the caller saw ready', () => {
  it('submits one turn after the paste instead of waiting out the render cap', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await launchedAgentPane('claude')

      const send = runtime.sendTerminalAgentPrompt(handle, 'fix the checks\nlog tail', {
        inputKind: 'launch',
        composerReady: true
      })
      await vi.advanceTimersByTimeAsync(49)
      expect(writes.map((write) => write.data)).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(2)
      await send
      expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { agent: 'codex', startsTurn: false, enters: 2 },
    { agent: 'qwen-code', startsTurn: false, enters: 2 },
    { agent: 'codex', startsTurn: true, enters: 1 }
  ] as const)(
    'sends $agent a second Enter after its retry delay only when no turn started: $startsTurn',
    async ({ agent, startsTurn, enters }) => {
      vi.useFakeTimers()
      try {
        const { runtime, handle, writes } = await launchedAgentPane(agent, startsTurn)

        const send = runtime.sendTerminalAgentPrompt(handle, 'explain this commit', {
          inputKind: 'launch',
          composerReady: true,
          acceptQueued: true,
          requestId: 'launch-retry',
          observationTimeoutMs: 0
        })
        await vi.advanceTimersByTimeAsync(51)
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1_200)
        await send
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(enters)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
