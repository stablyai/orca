import { describe, expect, it, vi, afterEach } from 'vitest'
import { createTranscriptPane } from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Canonical hook status readiness', () => {
  // The harness pane's identity (agent-transcript-pane-test-harness.ts).
  const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  const OTHER_PANE_KEY = makePaneKey('tab-9', '99999999-9999-4999-8999-999999999999')
  // A Pi turn in progress: no ready sign the other lanes could settle on.
  const BUSY_SCREEN = '⠋ Working...\r\n'
  // A Codex turn in progress, which Codex's screen rules read as busy.

  // OpenCode 1.18's permission dialog, as the line tail keeps it after the prompt is answered.
  const OPENCODE_PERMISSION_DIALOG = [
    '△ Permission required',
    '# Shell command',
    '$ echo hi',
    ' Allow once   Allow always   Reject     ctrl+f fullscreen  ⇆ select  enter confirm',
    ''
  ].join('\r\n')
  // OpenCode 1.18's question tool, which paints no dialog wording the blocked layer knows.

  // Shorter than the 2 s poll, so only the synchronous verdict can settle a wait.
  const WAIT_MS = 150

  function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    const now = Date.now()
    return {
      paneKey: PANE_KEY,
      connectionId: null,
      state: 'done',
      prompt: '',
      agentType: 'pi',
      receivedAt: now,
      stateStartedAt: now,
      ...overrides
    }
  }

  async function waitOutcome(options: {
    rows: (handle: string) => AgentStatusIpcPayload[]
    launchAgent?: TuiAgent
    data?: string
    afterCreate?: (runtime: OrcaRuntimeService, handle: string) => unknown
  }): Promise<string> {
    let handle = ''
    const pane = await createTranscriptPane(
      {
        paneTitle: 'Terminal',
        foregroundProcess: options.launchAgent ?? 'pi',
        data: options.data ?? BUSY_SCREEN,
        launchAgent: options.launchAgent ?? 'pi'
      },
      { getAgentStatusSnapshot: () => options.rows(handle) }
    )
    handle = pane.handle
    await options.afterCreate?.(pane.runtime, pane.handle)
    try {
      const result = await pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: WAIT_MS
      })
      return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tui-idle hook lane through the runtime', () => {
    it('joins a row on the terminal handle when its pane key is not the pane', async () => {
      expect(
        await waitOutcome({
          rows: (handle) => [row({ paneKey: OTHER_PANE_KEY, terminalHandle: handle })]
        })
      ).toBe('ready')
    })

    // Input starts a possible new turn, including typed agent restarts; prior done hooks cannot settle it.

    // Pi brackets each message in OSC 133 zones itself, so a command marker is no process boundary.
    it('keeps the row while the agent paints its own shell-integration markers', async () => {
      expect(
        await waitOutcome({
          rows: () => [row({ receivedAt: Date.now() - 1000 })],
          data: `\x1b]133;A\x07OK\x1b]133;C\x07${BUSY_SCREEN}`
        })
      ).toBe('ready')
    })

    it("settles past a denied prompt's dialog text once the hook says the turn ended", async () => {
      const options = { launchAgent: 'opencode' as const, data: OPENCODE_PERMISSION_DIALOG }
      expect(await waitOutcome({ ...options, rows: () => [] })).toBe(
        'blocked:agent-interactive-prompt'
      )
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', state: 'waiting', receivedAt: Date.now() + 1 })]
        })
      ).toBe('blocked:agent-interactive-prompt')
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', receivedAt: Date.now() + 1 })]
        })
      ).toBe('ready')
    })
  })
})
