import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'
import { hookAuthority } from './agent-state-rules/agent-state-rules-engine'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const BUSY_SCREEN = 'Working...\r\n'
const WAIT_MS = 150

function hookRows(events: readonly string[]): AgentStatusIpcPayload[] {
  const state = createHookListenerState()
  let rows: AgentStatusIpcPayload[] = []
  for (const hook_event_name of events) {
    const event = normalizeAndAccept(state, 'dsh', {
      hook_event_name,
      session_id: 'dsh-lead-session',
      prompt: 'Reply OK',
      tool_name: 'ask_user_question'
    })
    if (event) {
      const now = Date.now()
      rows = [
        {
          ...event.payload,
          paneKey: PANE_KEY,
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now
        }
      ]
    }
  }
  return rows
}

async function waitOutcome(options: {
  rows: AgentStatusIpcPayload[]
  afterCreate?: (runtime: OrcaRuntimeService) => unknown
  connectionId?: string
  data?: string
}): Promise<string> {
  const pane = await createTranscriptPane(
    {
      paneTitle: 'Terminal',
      foregroundProcess: 'dsh',
      launchAgent: 'dsh',
      data: options.data ?? BUSY_SCREEN,
      connectionId: options.connectionId
    },
    { getAgentStatusSnapshot: () => options.rows }
  )
  await options.afterCreate?.(pane.runtime)
  try {
    const result = await waitForWorkerAgentReady(pane.runtime, pane.handle, {
      agent: 'dsh',
      reusesTerminal: true,
      timeoutMs: WAIT_MS
    })
    return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const osc = (state: string) => `\x1b]9999;${JSON.stringify({ state, agentType: 'dsh' })}\x07`

describe('DSH native PTY lifecycle through worker readiness', () => {
  it('keeps asynchronous HTTP evidence identity-only', () => {
    expect(hookAuthority('dsh')).toBe('identity-only')
  })
  it.each([undefined, 'ssh-1'])(
    'settles native finalized idle on the existing PTY lane (%s)',
    async (connectionId) => {
      expect(await waitOutcome({ rows: [], connectionId, data: BUSY_SCREEN + osc('done') })).toBe(
        'ready'
      )
    }
  )
  it.each(['SessionStart', 'Stop', 'NativeIdle', 'SubagentStop'])(
    'does not settle on asynchronous %s alone',
    async (event) => {
      expect(await waitOutcome({ rows: hookRows([event]) })).toBe('timeout')
    }
  )
  it('refuses an idle superseded by running in the same PTY chunk', async () => {
    expect(
      await waitOutcome({ rows: [], data: `${BUSY_SCREEN}${osc('done')}${osc('working')}` })
    ).toBe('timeout')
  })
  it('refuses an idle superseded by running in split PTY chunks', async () => {
    expect(
      await waitOutcome({
        rows: [],
        data: BUSY_SCREEN + osc('done'),
        afterCreate: (runtime) =>
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, osc('working'), Date.now())
      })
    ).toBe('timeout')
  })
  it('keeps visible approval dialogs blocked despite native idle', async () => {
    expect(
      await waitOutcome({ rows: [], data: `Do you trust this folder?\r\n${osc('done')}` })
    ).toBe('blocked:agent-trust-workspace')
  })
})

describe('DSH first worker dispatch uses its captured composer', () => {
  it('does not need a fabricated native idle or SessionStart to deliver first input', async () => {
    const base = join(__dirname, '__fixtures__', 'dsh-tui-ready-no-key')
    const data = readFileSync(`${base}.txt`, 'utf8')
    const size: { cols: number; rows: number } = JSON.parse(
      readFileSync(`${base}.meta.json`, 'utf8')
    )
    const pane = await createTranscriptPane(
      {
        paneTitle: 'Terminal',
        foregroundProcess: 'dsh',
        launchAgent: 'dsh',
        data: '',
        size
      },
      { getAgentStatusSnapshot: () => [] }
    )
    vi.useFakeTimers()
    const ready = waitForWorkerAgentReady(pane.runtime, pane.handle, {
      agent: 'dsh',
      reusesTerminal: false,
      timeoutMs: 60_000
    })
    const outcome = ready.then((result) => result.satisfied)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
    await vi.advanceTimersByTimeAsync(2000)
    await expect(outcome).resolves.toBe(true)
  })
})
