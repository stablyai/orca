// A kept agent whose terminal died while Orca was closed: the restored-row sweep retires its row to
// an identity row and clears the pane. Its refused resume tells the person to un-keep it from the
// tab menu, which only lists panes whose facet reached the renderer — so after the clear, the
// window must still hear the facet the identity row carries, and every later change to it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunAccount } from '../../shared/agent-run-account'
import type * as HookServerModule from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn(), isReady: () => true }
}))
vi.mock('../agent-hooks/server', async (importOriginal) => {
  const actual = await importOriginal<typeof HookServerModule>()
  return { ...actual, agentHookServer: new actual.AgentHookServer() }
})
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPtyListener: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => null
}))
vi.mock('./synthetic-title-runtime', () => ({
  stopSyntheticTitleSpinnerTimer: vi.fn()
}))

import { agentHookServer } from '../agent-hooks/server'
import { retireRestoredStatusesWithDeadTerminals } from '../agent-hooks/restored-status-dead-terminal-sweep'
import { installMainWindowAgentStatusListeners } from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const KEPT_PANE = makePaneKey('tab-kept', '11111111-1111-4111-8111-111111111111')
const PLAIN_PANE = makePaneKey('tab-plain', '22222222-2222-4222-8222-222222222222')
const KEPT: AgentRunAccount = {
  provider: 'codex',
  lane: 'host',
  accountId: 'account-a',
  mode: 'kept'
}

type Sent = { channel: string; event: Record<string, unknown> }
const sent: Sent[] = []
let dir = ''

/** Start the server over the status file an Orca that closed mid-turn leaves behind. */
async function restartMidTurn(): Promise<void> {
  const now = Date.now()
  const persisted = (paneKey: string, runAccount?: AgentRunAccount) => ({
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    connectionId: null,
    providerSession: { key: 'session_id', id: `resume-${paneKey}` },
    payload: { state: 'working', prompt: 'review the PR', agentType: 'codex' },
    receivedAt: now,
    stateStartedAt: now,
    ...(runAccount ? { runAccount } : {})
  })
  mkdirSync(join(dir, 'agent-hooks'), { recursive: true })
  writeFileSync(
    join(dir, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      version: 2,
      entries: { [KEPT_PANE]: persisted(KEPT_PANE, KEPT), [PLAIN_PANE]: persisted(PLAIN_PANE) },
      authorityCommitments: {}
    })
  )
  await agentHookServer.start({ env: 'production', userDataPath: dir })
}

function sweepDeadTerminals(): Promise<number> {
  return retireRestoredStatusesWithDeadTerminals({
    server: agentHookServer,
    probePtyLiveness: async () => false,
    isLocalExecutionHost: () => true,
    getBoundPtyIdForPaneKey: () => undefined,
    getPersistedPtyIdForPaneKey: (paneKey) => `pty-${paneKey}`
  })
}

function forPane(paneKey: string): string[] {
  return sent
    .filter((entry) => entry.event.paneKey === paneKey)
    .map((entry) =>
      entry.channel === 'agentStatus:clear'
        ? 'clear'
        : `${entry.event.providerSessionOnly ? 'identity' : 'status'}:${JSON.stringify(
            entry.event.runAccount
          )}`
    )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-kept-identity-facet-'))
  sent.length = 0
  mainProcessState.runtime = null
  mainProcessState.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: Record<string, unknown>) => sent.push({ channel, event })
    }
  } as unknown as typeof mainProcessState.mainWindow
})

afterEach(() => {
  agentHookServer.setListener(null)
  agentHookServer.setPaneStatusClearListener(null)
  agentHookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('a kept agent whose terminal died while Orca was closed', () => {
  it('keeps its facet in the window after the sweep clears the pane, through un-keep', async () => {
    await restartMidTurn()
    installMainWindowAgentStatusListeners({
      window: mainProcessState.mainWindow!,
      onRecordAgentState: vi.fn()
    })
    sent.length = 0

    expect(await sweepDeadTerminals()).toBe(2)

    expect(forPane(KEPT_PANE)).toEqual(['clear', `identity:${JSON.stringify(KEPT)}`])
    // Upstream unchanged for a row with no facet: the clear alone.
    expect(forPane(PLAIN_PANE)).toEqual(['clear'])

    sent.length = 0
    // What un-keeping a refused resume does when nothing observes the agent any more.
    expect(agentHookServer.republishRunAccount(KEPT_PANE, null)).toBe(true)
    expect(forPane(KEPT_PANE)).toEqual(['identity:null'])
  })

  it('replays the identity row with its facet to a window opened after the sweep', async () => {
    await restartMidTurn()
    await sweepDeadTerminals()

    installMainWindowAgentStatusListeners({
      window: mainProcessState.mainWindow!,
      onRecordAgentState: vi.fn()
    })

    expect(forPane(KEPT_PANE)).toEqual([`identity:${JSON.stringify(KEPT)}`])
    expect(agentHookServer.getStatusSnapshotForPane(KEPT_PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      runAccount: KEPT
    })
  })

  // The same identity-row path carries a fresh resume's facet before its first turn reports.
  it("forwards the facet the producer publishes on a resume launch's identity row", async () => {
    await restartMidTurn()
    installMainWindowAgentStatusListeners({
      window: mainProcessState.mainWindow!,
      onRecordAgentState: vi.fn()
    })
    sent.length = 0

    agentHookServer.recordLaunchResumeIdentity({
      paneKey: KEPT_PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'resumed-session' },
      launchedAt: Date.now() + 1_000
    })
    expect(agentHookServer.republishRunAccount(KEPT_PANE, KEPT)).toBe(true)

    expect(forPane(KEPT_PANE)).toEqual(['identity:undefined', `identity:${JSON.stringify(KEPT)}`])
  })
})
