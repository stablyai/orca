import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import { projectTerminalTopologySlice } from './terminal-topology-projection'

const WT = 'repo-1::/tmp/wt-a'
const OTHER = 'repo-1::/tmp/wt-b'

function tab(id: string, worktreeId: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 10,
    ...overrides
  }
}

function sleepingRecord(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'provider-1' },
    prompt: 'hi',
    state: 'done',
    capturedAt: 1,
    updatedAt: 2
  }
}

function splitAgentAndShellSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        tab('tab-agent', WT, {
          ptyId: 'pty-agent',
          launchAgent: 'claude',
          defaultTitle: 'Terminal 1',
          customTitle: 'presentation only',
          color: 'red',
          sortOrder: 3,
          generation: 2
        })
      ],
      [OTHER]: [tab('tab-other', OTHER, { ptyId: 'pty-other' })]
    },
    terminalLayoutsByTabId: {
      'tab-agent': {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.4,
          first: { type: 'leaf', leafId: TEST_LEAF_1 },
          second: { type: 'leaf', leafId: TEST_LEAF_2 }
        },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-agent', [TEST_LEAF_2]: 'pty-shell' },
        titlesByLeafId: { [TEST_LEAF_2]: 'shell' },
        buffersByLeafId: { [TEST_LEAF_1]: 'scrollback' }
      },
      'tab-other': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`tab-agent:${TEST_LEAF_1}`]: sleepingRecord(`tab-agent:${TEST_LEAF_1}`, WT),
      [`tab-other:${TEST_LEAF_1}`]: sleepingRecord(`tab-other:${TEST_LEAF_1}`, OTHER)
    },
    terminalTopologyRevisionByRepoId: { 'repo-1': 7 }
  }
}

describe('projectTerminalTopologySlice', () => {
  it('keeps topology and creation fields of a split agent+shell tab and drops presentation', () => {
    const session = splitAgentAndShellSession()
    const before = structuredClone(session)

    expect(projectTerminalTopologySlice(session, 'local', WT)).toEqual({
      hostId: 'local',
      worktreeId: WT,
      revision: 7,
      tabs: [
        {
          id: 'tab-agent',
          worktreeId: WT,
          ptyId: 'pty-agent',
          launchAgent: 'claude',
          defaultTitle: 'Terminal 1',
          createdAt: 10
        }
      ],
      layouts: {
        'tab-agent': {
          root: session.terminalLayoutsByTabId['tab-agent']!.root,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-agent', [TEST_LEAF_2]: 'pty-shell' },
          titlesByLeafId: { [TEST_LEAF_2]: 'shell' }
        }
      },
      sleeping: {
        [`tab-agent:${TEST_LEAF_1}`]: sleepingRecord(`tab-agent:${TEST_LEAF_1}`, WT)
      }
    })
    expect(session).toEqual(before)
  })

  it('carries a sleeping record whose tab is gone but whose worktree matches', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WT]: [] },
      sleepingAgentSessionsByPaneKey: { [`gone:${TEST_LEAF_1}`]: sleepingRecord('gone', WT) }
    }

    expect(projectTerminalTopologySlice(session, 'local', WT)).toMatchObject({
      tabs: [],
      layouts: {},
      sleeping: { [`gone:${TEST_LEAF_1}`]: sleepingRecord('gone', WT) },
      revision: 0
    })
  })

  it('names the owning ssh partition and folder workspace keys as given', () => {
    const folder = folderWorkspaceKey('folder-1')
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [folder]: [tab('tab-f', folder, { startupCwd: '/tmp/f/sub' })] }
    }

    expect(projectTerminalTopologySlice(session, 'ssh:target-1', folder)).toEqual({
      hostId: 'ssh:target-1',
      worktreeId: folder,
      revision: 0,
      tabs: [
        { id: 'tab-f', worktreeId: folder, ptyId: null, createdAt: 10, startupCwd: '/tmp/f/sub' }
      ],
      layouts: {},
      sleeping: {}
    })
  })
})
