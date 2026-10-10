import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../../shared/tui-agent-resume-startup'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../loading-store/store'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WORKTREE,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// The mirror refactor moves sleeping records into main's own commits and makes window saves
// presentation-only; a slept agent must still be resumable after quit and relaunch.

const TAB = 'tab-agent'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = `${WORKTREE}@@0a1b2c3d`
const PANE_KEY = `${TAB}:${LEAF}`

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function record(origin: 'worktree-sleep' | 'quit', capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: TAB,
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${capturedAt}` },
    prompt: 'finish the task',
    state: 'waiting',
    capturedAt,
    updatedAt: capturedAt,
    origin
  }
}

/** The window's session after it spawned an agent pane, as its debounced save sends it. */
function windowSessionWithAgentPane(store: Store): WorkspaceSessionState {
  const session = structuredClone(store.getWorkspaceSession())
  session.tabsByWorktree = {
    ...session.tabsByWorktree,
    [WORKTREE]: [
      {
        id: TAB,
        ptyId: PTY,
        worktreeId: WORKTREE,
        title: 'codex',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        launchAgent: 'codex'
      }
    ]
  }
  session.terminalLayoutsByTabId = {
    ...session.terminalLayoutsByTabId,
    [TAB]: {
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF]: PTY }
    }
  }
  return session
}

async function storeWithAgentPane() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sleep-quit-resume-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = windowSessionWithAgentPane(store)
  store.setWorkspaceSession(structuredClone(window))
  await expect(
    store.persistPtyBinding({ worktreeId: WORKTREE, tabId: TAB, leafId: LEAF, ptyId: PTY })
  ).resolves.toBe(true)
  return { directory, store, window }
}

/** What main holds for the slept pane: its record, the worktree's tabs and the pane's binding. */
function heldForPane(store: Store) {
  const session = store.getWorkspaceSession()
  const record = session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
  return {
    record,
    // A reader of this worktree's records finds it: the record names the worktree.
    worktreeRecord: record?.worktreeId === WORKTREE ? record : undefined,
    tabs: (session.tabsByWorktree[WORKTREE] ?? []).map((tab) => tab.id),
    binding: session.terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[LEAF]
  }
}

function resumeCommand(held: SleepingAgentSessionRecord | undefined): string | undefined {
  return held
    ? buildAgentResumeStartupPlan({
        agent: held.agent,
        providerSession: held.providerSession,
        cmdOverrides: {},
        platform: 'linux'
      })?.launchCommand
    : undefined
}

describe('sleep → quit → resume', () => {
  it('keeps the quit capture over the periodic one through quit and relaunch', async () => {
    const { directory, store, window } = await storeWithAgentPane()
    // The agent is slept; the periodic save carries the first capture.
    window.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: record('worktree-sleep', 1) }
    store.setWorkspaceSession(structuredClone(window))
    // Quit: the window's quit capture rides only on the synchronous before-unload stage.
    window.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: record('quit', 2) }
    store.stageWorkspaceSessionBeforeUnload(structuredClone(window))

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const expected = {
        record: record('quit', 2),
        worktreeRecord: record('quit', 2),
        tabs: [TAB],
        binding: PTY
      }
      expect(heldForPane(relaunched)).toEqual(expected)
      // The relaunched window's first save is its hydrated copy; the record stays.
      relaunched.setWorkspaceSession(structuredClone(relaunched.getWorkspaceSession()))
      expect(heldForPane(relaunched)).toEqual(expected)
      expect(resumeCommand(heldForPane(relaunched).record)).toBe("codex 'resume' 'session-2'")
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps a record that only the before-unload stage carried', async () => {
    const { directory, store, window } = await storeWithAgentPane()
    window.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: record('quit', 3) }
    store.stageWorkspaceSessionBeforeUnload(structuredClone(window))

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      expect(heldForPane(relaunched)).toEqual({
        record: record('quit', 3),
        worktreeRecord: record('quit', 3),
        tabs: [TAB],
        binding: PTY
      })
      expect(resumeCommand(heldForPane(relaunched).record)).toBe("codex 'resume' 'session-3'")
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })
})
