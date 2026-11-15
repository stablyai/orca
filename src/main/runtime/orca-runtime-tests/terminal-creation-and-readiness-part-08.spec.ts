import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import '../../../shared/constants'
import './runtime-test-module-registration.spec'
import { AGENT_PROMPT_BRACKETED_PASTE_START } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import '../../../shared/clipboard/clipboard-text'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../shared/terminal/input/terminal-input'
import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
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
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
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
