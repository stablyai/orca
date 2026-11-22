import { describe, expect, it, vi } from 'vitest'
import '../layout/bind-first-pane.test-fixture'
import '../../../../shared/orca-profiles/constants'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../../../shared/agent-launch/startup/agent-prompt-injection'
import '../../../../shared/clipboard/clipboard-text'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../orca-runtime-test-mocks/setup.spec'
import '../../../../shared/terminal/input/terminal-input'
import {
  TEST_WORKTREE_PATH,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
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
