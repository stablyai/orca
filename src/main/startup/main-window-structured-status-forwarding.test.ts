// PR 2b: main is the writer for a locally hosted structured session, so the window listener
// forwards its rows like any other. It sends to BOTH renderer windows, which is what first gives
// the dashboard popout structured sessions at all — the popout has never had them.
//
// The two things it must NOT do for a paneless row: drive a synthetic terminal title into a pane
// that does not exist, and trip first-work branch rename, whose structured-session gap is tracked
// on its own.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'

const hooks = vi.hoisted(() => ({
  listener: null as ((payload: EnrichedAgentHookEventPayload) => void) | null,
  popout: null as { webContents: { send: (channel: string, event: unknown) => void } } | null,
  driveSyntheticTitleFromHook: vi.fn()
}))

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
  getDashboardPopoutWindow: () => hooks.popout
}))
vi.mock('./synthetic-title-runtime', () => ({
  driveSyntheticTitleFromHook: hooks.driveSyntheticTitleFromHook,
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook: () => false,
  stopAllSyntheticTitleSpinners: vi.fn()
}))

import { installMainWindowAgentStatusListeners } from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const sent: { channel: string; event: { paneKey: string } }[] = []
const popoutSent: { channel: string; event: { paneKey: string } }[] = []
const autoRenamed: { paneKey: string }[] = []
const STRUCTURED_PANE_KEY = 'structured-agent-session-s1:leaf'

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
  popoutSent.length = 0
  autoRenamed.length = 0
  hooks.driveSyntheticTitleFromHook.mockClear()
  hooks.listener = null
  hooks.popout = {
    webContents: {
      send: (channel: string, event: unknown) =>
        popoutSent.push({ channel, event: event as { paneKey: string } })
    }
  }
  mainProcessState.runtime = null
  mainProcessState.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: { paneKey: string }) => sent.push({ channel, event })
    }
  } as unknown as typeof mainProcessState.mainWindow
  installMainWindowAgentStatusListeners({
    window: mainProcessState.mainWindow!,
    maybeAutoRenameBranchOnFirstWork: (event) => autoRenamed.push({ paneKey: event.paneKey }),
    onRecordAgentState: vi.fn()
  })
})

describe('the main-window agent-status listener', () => {
  it('forwards a structured row to both renderer windows, carrying its host ownership', () => {
    expect(hooks.listener).not.toBeNull()

    hooks.listener!(statusPayload({ paneKey: 'hook-pane' }))
    hooks.listener!(statusPayload({ paneKey: STRUCTURED_PANE_KEY, structuredHost: 'owned' }))

    expect(sent.map((entry) => `${entry.channel}:${entry.event.paneKey}`)).toEqual([
      'agentStatus:set:hook-pane',
      `agentStatus:set:${STRUCTURED_PANE_KEY}`
    ])
    // The popout has never had structured sessions; removing the send guard is what gives it them.
    expect(popoutSent.map((entry) => `${entry.channel}:${entry.event.paneKey}`)).toEqual([
      'agentStatus:set:hook-pane',
      `agentStatus:set:${STRUCTURED_PANE_KEY}`
    ])
    expect(sent[1]?.event).toMatchObject({ structuredHost: 'owned' })
  })

  it('drives no synthetic terminal title and no first-work rename for a paneless row', () => {
    // `blocked` is a state the codex profile does synthesize a title for, so the PTY row proves
    // the arm is live and the structured row proves it is skipped.
    const blocked = {
      payload: { state: 'blocked', prompt: 'ship it', agentType: 'codex' }
    } as Partial<EnrichedAgentHookEventPayload>
    hooks.listener!(statusPayload({ paneKey: 'hook-pane', ...blocked }))
    hooks.listener!(
      statusPayload({ paneKey: STRUCTURED_PANE_KEY, structuredHost: 'held', ...blocked })
    )

    expect(autoRenamed).toEqual([{ paneKey: 'hook-pane' }])
    expect(hooks.driveSyntheticTitleFromHook.mock.calls.map((call) => call[0])).toEqual([
      'hook-pane'
    ])
  })
})
