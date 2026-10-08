import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const ready = readFileSync(
  join(import.meta.dirname, '__fixtures__/claude-ready-task-wakeup.txt'),
  'utf8'
)

function owedRow(paneKey: string): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey,
    state: 'working',
    mainAgent: { state: 'done', stateStartedAt: now },
    agentType: 'claude',
    prompt: '',
    connectionId: null,
    launchToken: 'transcript-launch',
    claudeTaskWakeupPending: 'notification',
    providerSession: { key: 'session_id', id: 'session-a' },
    observation: {
      origin: 'hook',
      authorityId: 'host-a',
      incarnation: 1,
      revision: 1,
      observedAt: now
    },
    receivedAt: now,
    stateStartedAt: now
  }
}

afterEach(() => vi.useRealTimers())

describe('Claude readiness indexed status reads', () => {
  it.each([true, false])(
    'reads only its pane with 512 unrelated agents, including an empty index: pending=%s',
    async (pending) => {
      const unrelated = Array.from({ length: 512 }, (_, index) => owedRow(`other:${index}`))
      const row = owedRow(PANE)
      const full = vi.fn(() => [row, ...unrelated])
      const indexed = vi.fn((paneKey: string) => (pending && paneKey === PANE ? [row] : []))
      const pane = await createTranscriptPane(
        {
          paneTitle: 'Terminal',
          foregroundProcess: 'claude',
          data: ready,
          launchAgent: 'claude'
        },
        { getAgentStatusSnapshot: full, getAgentStatusSnapshotForPane: indexed }
      )
      row.receivedAt = Date.now()
      full.mockClear()
      indexed.mockClear()
      try {
        const waiting = waitForTranscriptIdle(pane, 2_000)
        await (pending
          ? expect(waiting).rejects.toThrow(/timeout/)
          : expect(waiting).resolves.toMatchObject({ satisfied: true }))
        expect(indexed).toHaveBeenCalled()
        expect(new Set(indexed.mock.calls.map(([paneKey]) => paneKey))).toEqual(new Set([PANE]))
        expect(full).not.toHaveBeenCalled()
      } finally {
        pane.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      }
    }
  )
})
