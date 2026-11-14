import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('a worker start reusing a pane whose agent is mid-turn', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Claude's spinner title while a turn runs.
  function midTurnClaudePane() {
    return createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'claude',
      data: '\x1b]0;⠂ Watch PR checks\x07✻ Running gh pr checks --watch…\r\n',
      launchAgent: 'claude'
    })
  }

  it('is ready at once, since the agent queues a task sent mid-turn', async () => {
    const pane = await midTurnClaudePane()
    await expect(
      waitForWorkerAgentReady(pane.runtime, pane.handle, {
        agent: undefined,
        reusesTerminal: true,
        timeoutMs: 150
      })
    ).resolves.toMatchObject({ satisfied: true })
  })
})
