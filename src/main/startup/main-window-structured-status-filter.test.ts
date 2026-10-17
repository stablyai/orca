// The renderer half of the half-migration seam.
//
// Until PR 2 retires `StructuredAgentSessionStatusBridge`, the renderer writes structured rows
// itself. Main forwarding them too would give one pane key two writers, so the window listener
// drops them — a filter nothing else asserts, which makes deleting it green everywhere.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'

const hooks = vi.hoisted(() => ({
  listener: null as ((payload: EnrichedAgentHookEventPayload) => void) | null
}))
const record = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn(), isReady: () => true }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    setListener: (listener: ((payload: EnrichedAgentHookEventPayload) => void) | null) => {
      hooks.listener = listener
    },
    setPaneStatusClearListener: vi.fn()
  }
}))
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPtyListener: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => null
}))
vi.mock('./synthetic-title-runtime', () => ({
  stopSyntheticTitleSpinnerTimer: vi.fn()
}))

import { installMainWindowAgentStatusListeners } from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const sent: { channel: string; event: { paneKey: string } }[] = []

function statusPayload(
  over: Partial<EnrichedAgentHookEventPayload>
): EnrichedAgentHookEventPayload {
  return {
    paneKey: 'pane-1',
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
    ...over
  } as EnrichedAgentHookEventPayload
}

beforeEach(() => {
  sent.length = 0
  hooks.listener = null
  mainProcessState.runtime = null
  mainProcessState.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: { paneKey: string }) => sent.push({ channel, event })
    }
  } as unknown as typeof mainProcessState.mainWindow
  record.mockReset()
  installMainWindowAgentStatusListeners({
    window: mainProcessState.mainWindow!,
    onRecordAgentState: record
  })
})

describe('the main-window agent-status listener', () => {
  it('forwards a hook row but never a structured one', () => {
    expect(hooks.listener).not.toBeNull()

    hooks.listener!(statusPayload({ paneKey: 'hook-pane' }))
    hooks.listener!(
      statusPayload({
        paneKey: 'structured-agent-session-s1:leaf',
        structuredHost: 'owned'
      })
    )

    expect(sent.map((entry) => `${entry.channel}:${entry.event.paneKey}`)).toEqual([
      'agentStatus:set:hook-pane'
    ])
  })
})

it('forwards retirement acknowledgement only on live status delivery', () => {
  hooks.listener!(statusPayload({ authorityRestartId: 'retirement-id' }))
  hooks.listener!(statusPayload({ authorityRestartId: 'retirement-id', isReplay: true }))
  expect(sent[0].event).toHaveProperty('authorityRestartId', 'retirement-id')
  expect(sent[1].event).not.toHaveProperty('authorityRestartId')
})

// The live push picks fields one by one; the host's turn start must be one of them.
it("forwards the host's turn start, and nothing when the host stamped none", () => {
  hooks.listener!(statusPayload({ turnStartedAt: 1 }))
  hooks.listener!(statusPayload({}))
  expect(sent[0].event).toHaveProperty('turnStartedAt', 1)
  expect(sent[1].event).not.toHaveProperty('turnStartedAt')
})

// Without the flag the renderer sees a reconnect replay as a fresh completion and re-notifies.
it('marks replayed rows so the renderer can skip their completion notification', () => {
  hooks.listener!(statusPayload({ payload: { state: 'done', prompt: 'ship it' } }))
  hooks.listener!(statusPayload({ payload: { state: 'done', prompt: 'ship it' }, isReplay: true }))
  expect(sent[0].event).not.toHaveProperty('isReplay')
  expect(sent[1].event).toHaveProperty('isReplay', true)
})

it('forwards the host account facet, including a withdrawal, and nothing when absent', () => {
  const facet = { provider: 'codex', lane: 'host', accountId: 'a', mode: 'kept' } as const
  hooks.listener!(statusPayload({ paneKey: 'kept', runAccount: facet }))
  hooks.listener!(statusPayload({ paneKey: 'withdrawn', runAccount: null }))
  hooks.listener!(statusPayload({ paneKey: 'plain' }))

  const byPane = new Map(sent.map((entry) => [entry.event.paneKey, entry.event]))
  expect(byPane.get('kept')).toMatchObject({ runAccount: facet })
  expect(byPane.get('withdrawn')).toMatchObject({ runAccount: null })
  expect(byPane.get('plain')).not.toHaveProperty('runAccount')
})

// Titles and first-work renames hang off the hook subscription, which a facet restatement never
// reaches (server-run-account.test.ts); this listener must still skip telemetry and stay a replay.
it('forwards a facet-only restatement as a replay without recording telemetry', () => {
  const facet = { provider: 'codex', lane: 'host', accountId: 'a', mode: 'kept' } as const
  const waiting = { state: 'waiting', prompt: '', agentType: 'codex' } as const
  hooks.listener!(statusPayload({ payload: waiting, runAccount: facet, isReplay: true }))
  expect(record).toHaveBeenCalledOnce()
  record.mockClear()
  sent.length = 0

  hooks.listener!(
    statusPayload({ payload: waiting, runAccount: facet, isReplay: true, runAccountOnly: true })
  )

  expect(sent.map((entry) => entry.event)).toEqual([
    expect.objectContaining({ paneKey: 'pane-1', runAccount: facet, isReplay: true })
  ])
  expect(record).not.toHaveBeenCalled()
})
