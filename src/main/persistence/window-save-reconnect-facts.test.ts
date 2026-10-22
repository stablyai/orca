import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { SshConnectionStatus } from '../../shared/ssh-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SSH_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { deriveShutdownReconnectFacts } from '../runtime/terminal/recovery/shutdown-reconnect-facts'
import { windowViewPatchForMain, windowViewSaveForMain } from './window-save-view'

const TARGET = 'target'
const SSH_HOST = toSshExecutionHostId(TARGET)
const RELAY = `ssh:${TARGET}@@pty-42`

function sshPartition(): WorkspaceSessionState {
  return addWorkspace(
    emptySession(),
    SSH_KEY,
    [{ id: 'group-s', tabs: [{ id: 'tab-s', leaves: [[leaf(3), RELAY]] }] }],
    SSH_HOST
  )
}

function localPartition(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-g',
      tabs: [
        { id: 'tab-live', leaves: [[leaf(1), 'pty-live']] },
        { id: 'tab-gone', leaves: [[leaf(2), 'pty-gone']] }
      ]
    }
  ])
}

const factsFor =
  (
    live: string[],
    ssh: [string, SshConnectionStatus][],
    more: { exited?: string[]; others?: WorkspaceSessionState[] } = {}
  ) =>
  (session: WorkspaceSessionState) =>
    deriveShutdownReconnectFacts(session, {
      isLiveLocalPty: (ptyId) => live.includes(ptyId),
      isKnownExited: (ptyId) => more.exited?.includes(ptyId) ?? false,
      sshStatusByTargetId: new Map(ssh),
      otherPartitions: () => more.others ?? []
    })

/** A window that never visited the SSH workspace and lost its reconnect bookkeeping. */
function forgetfulSave(stored: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...stored,
    activeWorktreeIdsOnShutdown: [],
    remoteSessionIdsByTabId: undefined,
    activeConnectionIdsAtShutdown: undefined
  }
}

describe('what the next startup reconnects comes from main, not the window’s save', () => {
  it('keeps an unvisited SSH tab’s relay session and its target the window dropped', () => {
    const stored = sshPartition()

    const saved = windowViewSaveForMain(
      stored,
      forgetfulSave(stored),
      SSH_HOST,
      factsFor([], [[TARGET, 'reconnecting']])
    )

    expect(saved.remoteSessionIdsByTabId).toEqual({ 'tab-s': RELAY })
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([SSH_KEY])
    expect(saved.activeConnectionIdsAtShutdown).toEqual([TARGET])
  })

  it('names only workspaces with a running local terminal, whatever the window sent', () => {
    const stored = localPartition()
    const save = { ...stored, activeWorktreeIdsOnShutdown: ['repo-1::/elsewhere'] }

    const saved = windowViewSaveForMain(stored, save, null, factsFor(['pty-live'], []))

    expect(saved.activeWorktreeIdsOnShutdown).toEqual([GIT_KEY])
    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved).not.toHaveProperty('activeConnectionIdsAtShutdown')
    expect(
      windowViewSaveForMain(stored, save, null, factsFor([], [])).activeWorktreeIdsOnShutdown
    ).toEqual([])
  })

  it('a slept pane keeps its relay id as a wake hint only: the next startup does not reconnect it', () => {
    const stored = sshPartition()
    stored.sleepingAgentSessionsByPaneKey = {
      [`tab-s:${leaf(3)}`]: {
        paneKey: `tab-s:${leaf(3)}`,
        worktreeId: SSH_KEY,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-1' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
    }

    const saved = windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], []))

    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([])
  })

  it.each(['live', 'quit'] as const)(
    'a running agent’s %s resume record is not a sleep: its relay session reconnects',
    (origin) => {
      const stored = sshPartition()
      stored.sleepingAgentSessionsByPaneKey = {
        [`tab-s:${leaf(3)}`]: {
          paneKey: `tab-s:${leaf(3)}`,
          worktreeId: SSH_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin
        }
      }

      const saved = windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], []))

      expect(saved.remoteSessionIdsByTabId).toEqual({ 'tab-s': RELAY })
      expect(saved.activeWorktreeIdsOnShutdown).toEqual([SSH_KEY])
    }
  )

  it('a target the user left offline is not redialed; a connected one is', () => {
    const stored = sshPartition()

    expect(
      windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], [[TARGET, 'disconnected']]))
    ).not.toHaveProperty('activeConnectionIdsAtShutdown')
    expect(
      windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], [['other', 'connected']]))
        .activeConnectionIdsAtShutdown
    ).toEqual(['other'])
  })

  it('the local save names a target in a passing state from a relay session in its SSH partition', () => {
    const local = localPartition()
    // The relay dropped mid-quit: the target reads reconnecting, not connected.
    const facts = factsFor([], [[TARGET, 'reconnecting']], { others: [sshPartition()] })

    expect(windowViewSaveForMain(local, local, null, facts).activeConnectionIdsAtShutdown).toEqual([
      TARGET
    ])
  })

  it('a relay session proven exited (a slept plain shell) is not reconnected', () => {
    const stored = sshPartition()

    const saved = windowViewSaveForMain(
      stored,
      stored,
      SSH_HOST,
      factsFor([], [[TARGET, 'reconnecting']], { exited: [RELAY] })
    )

    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([])
    expect(saved).not.toHaveProperty('activeConnectionIdsAtShutdown')
  })

  it('a patch has main’s facts only for the fields it carries', () => {
    const stored = sshPartition()
    const facts = factsFor([], [[TARGET, 'connected']])

    expect(
      windowViewPatchForMain(stored, { activeConnectionIdsAtShutdown: [] }, SSH_HOST, facts)
    ).toEqual({ activeConnectionIdsAtShutdown: [TARGET] })
    expect(windowViewPatchForMain(stored, { activeRepoId: 'r' }, SSH_HOST, facts)).toEqual({
      activeRepoId: 'r'
    })
  })
})
