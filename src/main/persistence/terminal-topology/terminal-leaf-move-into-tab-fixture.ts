import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalLeafIntoTabRequest } from '../../../shared/terminal-leaf-move'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { makeTerminalTab } from '../../persistence-session-fixtures'
import type { TerminalSessionPartition } from './terminal-topology-membership'

/** Shared by the into-tab planner and commit tests; S = the dragged tab, T = the target tab. */

export const WT = 'repo-1::/tmp/into-tab-worktree'
export const FOLDER_WT =
  'repo-1::/tmp/into-tab-folder::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const SOURCE = 'tab-source'
export const TARGET = 'tab-target'
export const A = '22222222-2222-4222-8222-222222222222'
export const B = '11111111-1111-4111-8111-111111111111'
export const C = '33333333-3333-4333-8333-333333333333'
export const FROM = `${SOURCE}:${A}`
export const TO = `${TARGET}:${A}`

export const intoRequest: TerminalLeafIntoTabRequest = {
  worktreeId: WT,
  sourceTabId: SOURCE,
  targetTabId: TARGET,
  targetLeafId: B,
  leafId: A,
  ptyId: 'pty-a',
  placement: { kind: 'beside', side: 'right' }
}

export function sleepingRecord(paneKey: string, tabId: string, worktreeId = WT) {
  return {
    paneKey,
    tabId,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-1' },
    prompt: 'go',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  } satisfies SleepingAgentSessionRecord
}

function unified(tabId: string, groupId: string, worktreeId: string, sortOrder: number): Tab {
  return {
    id: tabId,
    entityId: tabId,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

/** S is a single-leaf tab (leaf A, pty-a); T has two leaves (B, C) with its own primary pty-b. */
export function intoTabSession(
  patch: Partial<WorkspaceSessionState> = {},
  worktreeId = WT
): WorkspaceSessionState {
  const rows: TerminalTab[] = [
    makeTerminalTab({ id: SOURCE, worktreeId, ptyId: 'pty-a', sortOrder: 0 }),
    makeTerminalTab({ id: TARGET, worktreeId, ptyId: 'pty-b', sortOrder: 1 })
  ]
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: worktreeId,
    activeTabId: SOURCE,
    tabsByWorktree: { [worktreeId]: rows },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        root: { type: 'leaf', leafId: A },
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [A]: 'pty-a' },
        titlesByLeafId: { [A]: 'agent title' },
        buffersByLeafId: { [A]: 'buffer-a' },
        scrollbackRefsByLeafId: { [A]: 'ref-a' }
      },
      [TARGET]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: B },
          second: { type: 'leaf', leafId: C }
        },
        activeLeafId: C,
        expandedLeafId: B,
        ptyIdsByLeafId: { [B]: 'pty-b', [C]: 'pty-c' },
        titlesByLeafId: { [B]: 'b title' }
      }
    },
    unifiedTabs: {
      [worktreeId]: [
        unified(SOURCE, 'group-1', worktreeId, 0),
        unified(TARGET, 'group-2', worktreeId, 0)
      ]
    },
    tabGroups: {
      [worktreeId]: [
        { id: 'group-1', worktreeId, activeTabId: SOURCE, tabOrder: [SOURCE] },
        { id: 'group-2', worktreeId, activeTabId: TARGET, tabOrder: [TARGET] }
      ]
    },
    tabGroupLayouts: {
      [worktreeId]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      }
    },
    activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
    terminalPtyIncarnationsByPaneKey: { [FROM]: 'inc-a', [`${TARGET}:${B}`]: 'inc-b' },
    ...patch
  }
}

export function localPartition(session: WorkspaceSessionState): TerminalSessionPartition[] {
  return [{ hostId: 'local', session }]
}
