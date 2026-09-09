import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../../shared/agent-prompt-injection'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import { OrcaRuntimeService } from '../orca-runtime'
import { acknowledgeAgentPromptSubmit } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_PATH,
  antigravityReadyScreen,
  cursorBusyScreen,
  cursorReadyScreen,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resolves tui-idle from a Codex ready prompt even when stale startup lines remain', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Booting MCP server: computer-use(0s  esc to interrupt)\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        [
          'Starting MCP servers (0/2): codex_apps, computer-use (2s  esc to interrupt)',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug\n'
        ].join('')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by Antigravity readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityReadyScreen(),
        '\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by the ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Choose working directory to resume this session\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

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
      blockedReason: 'codex-hooks-review-prompt'
    })
  })

  it('returns a blocked wait result for Codex update prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        '1. Update now\n',
        '2. Skip\n',
        'Press enter to continue\n'
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
      blockedReason: 'codex-update-prompt'
    })
  })

  it('returns a blocked wait result for Codex workspace trust prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      'Do you trust this workspace directory?\n1. Yes\n2. No\n',
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-trust-workspace'
    })
  })

  it('resolves tui-idle for an idle Cursor lane past its dismissed trust dialog (#8210)', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    // Cursor's dismissed trust dialog stays in scrollback; the later idle prompt must clear that stale hit and satisfy idle.
    runtime.onPtyData(
      'pty-bg',
      [
        // Trust dialog mentions "Cursor Agent" before the ready banner; lastIndexOf must pick the later banner, not this hit.
        'Cursor Agent\n',
        '⚠ Workspace Trust Required\n',
        'Do you trust the contents of this directory?\n',
        '  ▶ [a] Trust this workspace\n',
        '    [q] Quit\n',
        cursorReadyScreen()
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('does not block a mid-run Cursor lane on its dismissed trust dialog (#8210)', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        // Same earlier "Cursor Agent" hit as the idle case — banner must win.
        'Cursor Agent\n',
        '⚠ Workspace Trust Required\n',
        'Do you trust the contents of this directory?\n',
        '  ▶ [a] Trust this workspace\n',
        '    [q] Quit\n',
        cursorBusyScreen()
      ].join(''),
      Date.now()
    )

    // Busy Cursor is neither blocked nor idle, so the wait times out honestly instead of returning a stale trust block.
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
    ).rejects.toThrow('timeout')
  })

  it('returns a blocked wait result for Codex cwd selection prompts', async () => {
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
        'Choose working directory to resume this session\n',
        '  Session = latest cwd recorded in the resumed session\n',
        '  Current = your current working directory\n',
        '  Press enter to continue\n'
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
      blockedReason: 'codex-cwd-prompt'
    })
  })

  it('returns a blocked wait result for Codex model migration prompts', async () => {
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
        'Codex just got an upgrade. Introducing gpt-5.1-codex-max.\n',
        'We recommend switching from gpt-5-codex to gpt-5.1-codex-max.\n',
        'Press enter to continue\n'
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
      blockedReason: 'codex-model-migration-prompt'
    })
  })

  it('returns a blocked wait result for Codex startup hook review prompts', async () => {
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
        'Hooks need review\n',
        '2 hooks are new or changed.\n',
        '1. Review hooks\n',
        '2. Trust all and continue\n',
        'Press enter to confirm or esc to go back\n'
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
      blockedReason: 'codex-hooks-review-prompt'
    })
  })

  it('returns a blocked wait result for generic Codex interactive prompts', async () => {
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
        'Would you like to grant these permissions?\n',
        '1. Yes, grant these permissions for this turn\n',
        '2. No, continue without permissions\n',
        'Press enter to confirm or esc to cancel\n'
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
      blockedReason: 'codex-interactive-prompt'
    })
  })

  it('does not classify unrelated press-enter prompts as Codex blocked prompts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'Press enter to continue\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for quiet background PTY agents without OSC titles', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'OpenAI Codex\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 10_000
      })
      const waitAssertion = expect(waitPromise).resolves.toMatchObject({
        handle,
        condition: 'tui-idle',
        status: 'running'
      })

      await vi.advanceTimersByTimeAsync(6_000)

      await waitAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits text and enter writes for background terminal handles', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'continue', enter: true })

    expect(writes).toEqual(['continue', '\r'])
  })

  it('sends agent prompts as bracketed paste before submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      const prompt = 'line one\nline two\x1b[201~'

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt)
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasted = [
        AGENT_PROMPT_BRACKETED_PASTE_START,
        'line one\nline two<ESC>[201~',
        AGENT_PROMPT_BRACKETED_PASTE_END
      ].join('')
      expect(result).toMatchObject({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(`${pasted}\r`, 'utf8')
      })
      expect(writes).toEqual([pasted, '\r'])
    } finally {
      vi.useRealTimers()
    }
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

  it.each(
    (Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]).filter(
      (agent) => agent !== 'claude' && agent !== 'codex'
    )
  )('holds Enter for the full open-loop submit delay for %s', async (agent) => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: agent
      })

      const submitDelayMs = getAgentPromptSubmitDelayMs(
        process.platform,
        Buffer.byteLength(buildAgentPromptPasteBytes('review this change'), 'utf8')
      )
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change')
      await vi.advanceTimersByTimeAsync(submitDelayMs - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
