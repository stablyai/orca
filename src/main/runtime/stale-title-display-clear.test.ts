import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { clearWorkingIndicators } from '../../shared/agent-title-status'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Synthetic protocol cases: they test which title readiness, display and presence each read,
// not what a particular CLI paints. The 3 s timer is the stale-working-title clear.
describe('the stale-working title clear is display-only', () => {
  it.each([
    ['claude', '. claude', '* claude'],
    ['codex', '⠋ Codex working', 'Codex ready'],
    ['gemini', '✦ Gemini CLI', '◇ Gemini CLI'],
    ['opencode', '⠋ OC | task', 'OC | task'],
    ['pi', 'π : project', 'π - project']
  ] as const)(
    '%s does not become ready when its display title clears',
    async (agent, busy, idle) => {
      vi.useFakeTimers()
      try {
        const titleChanges: string[] = []
        const { runtime, handle } = await createTranscriptPane(
          {
            paneTitle: busy,
            foregroundProcess: agent,
            data: '',
            launchAgent: agent
          },
          {
            onTerminalSideEffects: (batch) => {
              for (const fact of batch.facts) {
                if (fact.kind === 'title') {
                  titleChanges.push(fact.normalizedTitle)
                }
              }
            }
          }
        )
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${busy}\x07`, Date.now())
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        expect(titleChanges.at(-1)).toBe(clearWorkingIndicators(busy))
        // A renderer graph publish can carry the display-only cleared title back to main.
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              title: clearWorkingIndicators(busy),
              activeLeafId: '11111111-1111-4111-8111-111111111111',
              layout: null
            }
          ],
          leaves: [
            {
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              leafId: '11111111-1111-4111-8111-111111111111',
              paneRuntimeId: 1,
              ptyId: TRANSCRIPT_PANE_PTY_ID,
              paneTitle: clearWorkingIndicators(busy)
            }
          ]
        })
        const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
        const assertion = expect(waiting).rejects.toThrow('timeout')
        await Promise.all([assertion, vi.advanceTimersByTimeAsync(200)])
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${idle}\x07`, Date.now())
        const ready = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
        const readyAssertion = expect(ready).resolves.toMatchObject({ satisfied: true })
        await Promise.all([readyAssertion, vi.advanceTimersByTimeAsync(2_000)])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  // A name-shaped title (`⠋ Codex working`) clears to `Codex`, which still names an agent, as on main.
  it.each([['⠋ repo']])(
    'an agent that exited behind %s does not pass for a running agent',
    async (title) => {
      vi.useFakeTimers()
      try {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'zsh',
          data: ''
        })
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${title}\x07`, Date.now())
        // The agent exits and the shell prints its prompt: output, but no title.
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]133;D;0\x07\x1b]133;A\x07% ', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: false,
          status: null
        })
        await expect(
          runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
        ).resolves.toBe(false)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('a live agent behind a cleared title is still found by its process', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        data: ''
      })
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ repo\x07', Date.now())
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: null
      })
      await expect(
        runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
      ).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the agent's next genuine title proves presence again", async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: null,
        data: ''
      })
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ repo\x07', Date.now())
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'still running\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: false
      })
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠙ repo\x07', Date.now())
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'working'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a live Cursor spinner title proves presence when no foreground read can answer', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: null,
      data: ''
    })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
  })
})
