import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// The harness pane's identity (agent-transcript-pane-test-harness.ts).
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
// codex-cli 0.160.0 (see its .meta.json): a Plan-mode turn, its menu, then '3' and the composer.
const FIXTURE = readRuntimeFixture('codex-0-160-0-plan-implement-menu')
const MENU_START = FIXTURE.indexOf('\x1b[30;1H\x1b[2m  Worked for')
const MENU_END = FIXTURE.indexOf('\x1b[?2026l', FIXTURE.indexOf('esc\x1b[22m', MENU_START))
// Codex output that quotes the menu as its turn's last lines, with no menu on screen.
const QUOTED_MENU = [
  '• The plan menu reads:',
  '  Implement this plan?',
  '  3. No, stay in Plan mode',
  '  enter select · esc back',
  ''
].join('\r\n')
const QUIESCENCE_MS = 3000

function doneRow(receivedAt: number): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    receivedAt,
    stateStartedAt: receivedAt
  }
}

/** Feeds bytes as PTY reads that arrive together, so the blocked scan runs on its trailing edge. */
function paint(runtime: OrcaRuntimeService, data: string): void {
  const at = Date.now()
  for (let i = 0; i < data.length; i += 64) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.slice(i, i + 64), at)
  }
}

async function waitOutcome(runtime: OrcaRuntimeService, handle: string, timeoutMs: number) {
  const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
  void waiting.catch(() => {})
  await vi.advanceTimersByTimeAsync(timeoutMs)
  try {
    const result = await waiting
    return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function codexPane(rows: () => AgentStatusIpcPayload[]) {
  const pane = await createTranscriptPane(
    {
      paneTitle: 'Terminal',
      foregroundProcess: 'codex',
      data: '',
      launchAgent: 'codex',
      size: { cols: 120, rows: 40 }
    },
    { getAgentStatusSnapshot: rows }
  )
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  return pane
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Codex plan menu painted after its Stop hook', () => {
  it('blocks on the menu over the earlier done, and settles once it is answered', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await codexPane(() => rows)
    paint(runtime, FIXTURE.slice(0, MENU_START))
    await vi.advanceTimersByTimeAsync(1000)
    rows = [doneRow(Date.now())]
    await vi.advanceTimersByTimeAsync(100)
    paint(runtime, FIXTURE.slice(MENU_START, MENU_END))

    expect(await waitOutcome(runtime, handle, 150)).toBe('blocked:agent-interactive-prompt')

    runtime.terminalRunFacts.recordInput(TRANSCRIPT_PANE_PTY_ID, 'driving', '3', Date.now())
    paint(runtime, FIXTURE.slice(MENU_END))
    expect(await waitOutcome(runtime, handle, QUIESCENCE_MS * 3)).toBe('ready')
  })

  it('settles on a done that follows output quoting the menu', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, handle } = await codexPane(() => rows)
    paint(runtime, QUOTED_MENU)
    await vi.advanceTimersByTimeAsync(100)
    rows = [doneRow(Date.now())]

    expect(await waitOutcome(runtime, handle, 150)).toBe('ready')
  })
})
