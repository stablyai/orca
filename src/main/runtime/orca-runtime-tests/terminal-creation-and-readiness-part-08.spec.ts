import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import '../../../shared/constants'
import './runtime-test-module-registration.spec'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes
} from '../../../shared/agent-launch/startup/agent-prompt-injection'
import '../../../shared/clipboard-text'
import { OrcaRuntimeService } from '../orca-runtime'
import { acknowledgeAgentPromptSubmit } from '../orca-runtime-test-mocks/setup.spec'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../../shared/terminal/input/terminal-input'
import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('settles a foreground Codex prompt when launch metadata has not arrived', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', '\x1b[?25hcomposer rendered', Date.now())
            }, 1_200)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(true)
      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(1_199)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise

      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a late Codex render marker a fresh quiescence window', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      let composerReady = false
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 7_900)
            setTimeout(() => {
              composerReady = true
              runtime.onPtyData('pty-bg', 'final slow composer frame', Date.now())
            }, 8_100)
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'codex'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(8_000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1_599)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(composerReady).toBe(true)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a Claude render that never settles to one fallback submit', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            setTimeout(() => runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now()), 100)
            for (const delay of [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]) {
              setTimeout(
                () => runtime.onPtyData('pty-bg', `render frame ${delay}`, Date.now()),
                delay
              )
            }
          }
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving'
      })
      // The 100ms marker re-arms render timeout, but cannot move the absolute ingest bound.
      await vi.advanceTimersByTimeAsync(100 + 8_000 - 1)
      expect(writes).not.toContain('\r')

      await vi.advanceTimersByTimeAsync(1)
      await sendPromise
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes large agent prompt paste frames atomically before delayed submit', async () => {
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
        launchAgent: 'claude'
      })
      const prompt = `${'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)}\ntail`

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
      await vi.runAllTimersAsync()
      const result = await sendPromise

      const pasteWrites = writes.slice(0, -1)
      expect(result.bytesWritten).toBe(
        Buffer.byteLength(`${buildAgentPromptPasteBytes(prompt)}\r`, 'utf8')
      )
      expect(writes.at(-1)).toBe('\r')
      expect(pasteWrites).toHaveLength(1)
      expect(pasteWrites.join('')).toBe(buildAgentPromptPasteBytes(prompt))
      expect(pasteWrites[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(pasteWrites.at(-1)).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an agent prompt when the atomic paste write fails', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data) => {
          writes.push(data)
          return false
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        launchAgent: 'claude'
      })
      const prompt = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)

      const sendPromise = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
      const sendRejection = expect(sendPromise).rejects.toThrow('terminal_not_writable')
      await vi.runAllTimersAsync()

      await sendRejection
      expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_START)
      expect(writes).toHaveLength(1)
      expect(writes).not.toContain('\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized terminal.send text before provider writes', async () => {
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

    await expect(
      runtime.sendTerminal(
        handle,
        { text: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) },
        { inputKind: 'driving' }
      )
    ).rejects.toThrow(TERMINAL_INPUT_TOO_LARGE_ERROR)
    expect(writes).toEqual([])
  })

  it('rejects focusing an exited background terminal session', async () => {
    const revealTerminalSession = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    revealTerminalSession.mockClear()
    runtime.onPtyExit('pty-bg', 0)

    await expect(runtime.focusTerminal(handle)).rejects.toThrow('terminal_exited')
    expect(revealTerminalSession).not.toHaveBeenCalled()
  })

  it('coalesces concurrent focusTerminal navigations so only the latest full reveal runs', async () => {
    // Resolve initial create immediately, then gate reveals for the focus storm.
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-create' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({ id: 'pty-a' })
        .mockResolvedValueOnce({ id: 'pty-b' })
        .mockResolvedValueOnce({ id: 'pty-c' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const a = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'a',
      presentation: 'background'
    })
    const b = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'b',
      presentation: 'background'
    })
    const c = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'c',
      presentation: 'background'
    })

    let releaseFirstReveal!: (value: { tabId: string }) => void
    let firstRevealStarted = false
    const firstRevealGate = new Promise<{ tabId: string }>((resolve) => {
      releaseFirstReveal = resolve
    })
    revealTerminalSession.mockReset()
    revealTerminalSession.mockImplementation(() => {
      if (!firstRevealStarted) {
        firstRevealStarted = true
        return firstRevealGate
      }
      return Promise.resolve({ tabId: 'tab-latest' })
    })

    const pA = runtime.focusTerminal(a.handle)
    await vi.waitFor(() => {
      expect(firstRevealStarted).toBe(true)
    })
    const pB = runtime.focusTerminal(b.handle)
    const pC = runtime.focusTerminal(c.handle)

    await expect(pB).resolves.toMatchObject({
      handle: b.handle,
      navigated: false
    })
    releaseFirstReveal({ tabId: 'tab-a' })
    const aResult = await pA
    expect(aResult.handle).toBe(a.handle)
    expect(aResult.navigated).toBe(false)
    await expect(pC).resolves.toMatchObject({
      handle: c.handle,
      tabId: 'tab-latest',
      navigated: true
    })

    const revealedPtyIds = revealTerminalSession.mock.calls.map(
      (call) => (call[1] as { ptyId?: string }).ptyId
    )
    expect(revealedPtyIds).not.toContain('pty-b')
    expect(revealedPtyIds.at(-1)).toBe('pty-c')
  })
})
