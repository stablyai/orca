import { describe, expect, it } from 'vitest'

import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import {
  buildRuntimeWorktreeSummaryPathIndex,
  createRuntimeWorktreePsSummaryLookup
} from './runtime-worktree-summary-paths'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from './runtime-worktree-ps-activity'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

const ID = 'repo-a::/srv/app'

function row(hostId: 'local' | 'ssh:server', instanceId: string): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: summaries read only these row fields.
  return {
    id: ID,
    repoId: 'repo-a',
    path: '/srv/app',
    branch: 'main',
    hostId,
    instanceId,
    identity: {
      key: `wt2:${encodeURIComponent(hostId)}:${instanceId}`,
      executionHostId: hostId,
      instanceId
    },
    displayName: 'app',
    comment: '',
    isArchived: false,
    isMainWorktree: true,
    linkedIssue: null,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path: '/srv/app', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
  } as unknown as ResolvedWorktree
}

const store = {
  getRepos: () => [
    { id: 'repo-a', path: '/srv/app', displayName: 'app', badgeColor: '#000', addedAt: 1 },
    {
      id: 'repo-a',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '#000',
      addedAt: 1,
      connectionId: 'server'
    }
  ],
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getFolderWorkspaces: () => [],
  getProjectGroups: () => []
}

describe('worktree ps rows that share an id on different hosts', () => {
  it('keeps each host row, its identity and only the activity its host proves', () => {
    const summaries = buildRuntimeWorktreePsSummaries({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: summaries read only these store methods.
      store: store as never,
      resolvedWorktrees: [row('local', 'inst-local'), row('ssh:server', 'inst-ssh')],
      platformByRepoId: new Map([['repo-a', 'linux']])
    })
    const getSummary = createRuntimeWorktreePsSummaryLookup(
      summaries,
      buildRuntimeWorktreeSummaryPathIndex(summaries, new Map([['repo-a', 'linux']]))
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activity reads only these PTY fields.
    const sshPty = {
      ptyId: 'pty-ssh',
      worktreeId: ID,
      connectionId: 'server',
      connected: true,
      lastOutputAt: 5,
      preview: ''
    } as unknown as RuntimePtyWorktreeRecord
    // A pane with no PTY record carries no host, so it can't pick a copy.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activity reads only these leaf fields.
    const unhostedLeaf = {
      ptyId: 'pty-unhosted',
      worktreeId: ID,
      connected: true,
      tabId: 'tab-1',
      lastOutputAt: 6,
      preview: ''
    } as unknown as RuntimeLeafRecord

    applyRuntimeWorktreePsTerminalActivity({
      freshPtyLiveness: new Set(['pty-ssh', 'pty-unhosted']),
      countedPtyIds: new Set(),
      leaves: [unhostedLeaf],
      ptysById: new Map([['pty-ssh', sshPty]]),
      tabs: new Map(),
      session: null,
      getPaneKey: () => 'tab-1:leaf-1',
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      getTitleDisplayClear: () => null,
      getSummary
    })

    expect(
      [...summaries.values()].map((summary) => ({
        hostId: summary.hostId,
        identity: summary.identity?.key,
        live: summary.liveTerminalCount
      }))
    ).toEqual([
      { hostId: 'local', identity: 'wt2:local:inst-local', live: 0 },
      { hostId: 'ssh:server', identity: 'wt2:ssh%3Aserver:inst-ssh', live: 1 }
    ])
  })

  it("marks each host's own row active from that host's session", () => {
    const summaries = buildRuntimeWorktreePsSummaries({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: summaries read only these store methods.
      store: store as never,
      resolvedWorktrees: [row('local', 'inst-local'), row('ssh:server', 'inst-ssh')],
      platformByRepoId: new Map()
    })
    const sessions: Record<string, unknown> = {
      local: getDefaultWorkspaceSession(),
      'ssh:server': { ...getDefaultWorkspaceSession(), activeWorktreeId: ID }
    }

    applyRuntimeWorktreePsSessionActivity({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session activity reads only workspace sessions.
      store: { getWorkspaceSession: (hostId: string) => sessions[hostId] } as never,
      summaries,
      // One entry per repo id, as the listing builds it: the SSH copy's repo is shadowed.
      repoById: new Map([['repo-a', store.getRepos()[0]]]),
      ptysById: new Map(),
      tabs: new Map(),
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      getTerminalHandlesForPty: () => [],
      getSummary: createRuntimeWorktreePsSummaryLookup(
        summaries,
        buildRuntimeWorktreeSummaryPathIndex(summaries, new Map())
      )
    })

    expect([...summaries.values()].map((summary) => [summary.hostId, summary.isActive])).toEqual([
      ['local', false],
      ['ssh:server', true]
    ])
  })
})
