import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// The harness pane's identity (agent-transcript-pane-test-harness.ts).
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const OTHER_PANE_KEY = makePaneKey('tab-9', '99999999-9999-4999-8999-999999999999')
// A Pi turn in progress: no ready sign the other lanes could settle on.
const BUSY_SCREEN = '⠋ Working...\r\n'
// A Codex turn in progress, which Codex's screen rules read as busy.
const CODEX_BUSY_SCREEN = '• Working (4s • esc to interrupt)\r\n'
// OpenCode 1.18's permission dialog, as the line tail keeps it after the prompt is answered.
const OPENCODE_PERMISSION_DIALOG = [
  '△ Permission required',
  '# Shell command',
  '$ echo hi',
  ' Allow once   Allow always   Reject     ctrl+f fullscreen  ⇆ select  enter confirm',
  ''
].join('\r\n')
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
  it('settles a mid-turn screen on the hook row alone, with no ready title (headless serve)', async () => {
    expect(await waitOutcome({ rows: () => [row()] })).toBe('ready')
  })

  it('without a row, the same pane does not settle', async () => {
    expect(await waitOutcome({ rows: () => [] })).toBe('timeout')
  })

  it('joins a row on the terminal handle when its pane key is not the pane', async () => {
    expect(
      await waitOutcome({
        rows: (handle) => [row({ paneKey: OTHER_PANE_KEY, terminalHandle: handle })]
      })
    ).toBe('ready')
  })

  it('falls back to the other lanes for a row no pane key or handle joins', async () => {
    expect(await waitOutcome({ rows: () => [row({ paneKey: OTHER_PANE_KEY })] })).toBe('timeout')
  })

  it('ignores the row the PTY id held before a respawn', async () => {
    const before = Date.now() - 1000
    const rows = (): AgentStatusIpcPayload[] => [
      row({ receivedAt: before, stateStartedAt: before })
    ]
    expect(await waitOutcome({ rows })).toBe('ready')
    expect(
      await waitOutcome({
        rows,
        afterCreate: (runtime) =>
          runtime.synchronizePtyOutputSequenceFromProvider(TRANSCRIPT_PANE_PTY_ID, {
            value: 0,
            generation: 'reset'
          })
      })
    ).toBe('timeout')
  })

  // Both write funnels record input (terminal-run-facts-input.test.ts), the user's keys included:
  // typing `pi` to restart the agent in the same shell must not read the old process's done.
  it.each([
    ['a prompt Orca sent', 'next task\r'],
    ['the user restarting the agent in the same shell', 'pi\r']
  ])('reads no done from before %s', async (_label, input) => {
    const before = Date.now() - 1000
    const rows = (): AgentStatusIpcPayload[] => [
      row({ receivedAt: before, stateStartedAt: before })
    ]
    const typeAt = (at: number) => (runtime: OrcaRuntimeService) => {
      runtime.terminalRunFacts.recordInput(TRANSCRIPT_PANE_PTY_ID, 'driving', input, at)
    }
    expect(await waitOutcome({ rows, afterCreate: typeAt(before - 1) })).toBe('ready')
    expect(await waitOutcome({ rows, afterCreate: typeAt(before + 1) })).toBe('timeout')
  })

  it('reads no done from before a prompt sent just ahead of an adoption of the running agent', async () => {
    const before = Date.now() - 1000
    const rows = (): AgentStatusIpcPayload[] => [
      row({ receivedAt: before, stateStartedAt: before })
    ]
    expect(
      await waitOutcome({
        rows,
        afterCreate: (runtime) => {
          runtime.terminalRunFacts.recordInput(
            TRANSCRIPT_PANE_PTY_ID,
            'driving',
            'next\r',
            before + 1
          )
          runtime.noteTerminalSpawnCommit({
            id: TRANSCRIPT_PANE_PTY_ID,
            agentSessionEnsure: { disposition: 'adopted' }
          })
        }
      })
    ).toBe('timeout')
  })

  // Pi brackets each message in OSC 133 zones itself, so a command marker is no process boundary.
  it('keeps the row while the agent paints its own shell-integration markers', async () => {
    expect(
      await waitOutcome({
        rows: () => [row({ receivedAt: Date.now() - 1000 })],
        data: `\x1b]133;A\x07OK\x1b]133;C\x07${BUSY_SCREEN}`
      })
    ).toBe('ready')
  })

  // Why: Codex before its Interrupt hook sends nothing for an Esc mid-turn, so its row can stay
  // working; its title and screen rules decide instead.
  it('leaves Codex to its screen rules, whatever its hook row says', async () => {
    const codex = { launchAgent: 'codex' as const, data: CODEX_BUSY_SCREEN }
    expect(await waitOutcome({ ...codex, rows: () => [row({ agentType: 'codex' })] })).toBe(
      'timeout'
    )
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
