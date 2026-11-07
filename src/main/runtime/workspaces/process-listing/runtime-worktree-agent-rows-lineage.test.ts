import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-types'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

const NOW = 1_700_000_000_000

function source(
  paneKey: string,
  worktreeId: string,
  terminalHandle: string
): RuntimeWorktreeAgentSource {
  return {
    paneKey,
    worktreeId,
    terminalHandle,
    connectionId: null,
    state: 'done',
    agentType: 'hermes',
    prompt: paneKey,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 2
  }
}

function workingSource(paneKey: string, worktreeId: string): RuntimeWorktreeAgentSource {
  return { ...source(paneKey, worktreeId, 'term'), state: 'working', updatedAt: NOW }
}

function summary(worktreeId: string): RuntimeWorktreePsSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test fixture
  return {
    worktreeId,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  } as unknown as RuntimeWorktreePsSummary
}

describe('worktree agent rows nest orchestration workers across folder workspaces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('places a worker under the coordinator pane even when the stored parent pane is gone', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const summaries = new Map([
      ['folder:orca', summary('folder:orca')],
      ['folder:babysitter', summary('folder:babysitter')]
    ])
    const rowSources = new Map([
      [coordinator, source(coordinator, 'folder:orca', 'term_coord')],
      [worker, source(worker, 'folder:babysitter', 'term_worker')]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources,
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: {
        [worker]: {
          parentPaneKey: 'tab-stale:leaf-stale',
          parentTerminalHandle: 'term_coord'
        }
      },
      getSummary: (id) => summaries.get(id) ?? null
    })
    const nested = summaries.get('folder:orca')?.agents ?? []
    expect(nested.map((row) => [row.paneKey, row.parentPaneKey])).toEqual([
      [coordinator, null],
      [worker, coordinator]
    ])
    expect(summaries.get('folder:orca')?.hasHostSidebarActivity).toBe(false)
    expect(summaries.get('folder:babysitter')?.agents.map((row) => row.parentPaneKey)).toEqual([
      coordinator
    ])
  })

  it('leaves a worker flat when the host has no orchestration parent', () => {
    const worker = 'tab-worker:leaf-worker'
    const summaries = new Map([['folder:babysitter', summary('folder:babysitter')]])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([[worker, source(worker, 'folder:babysitter', 'term_worker')]]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: {},
      getSummary: (id) => summaries.get(id) ?? null
    })
    expect(summaries.get('folder:babysitter')?.agents[0]?.parentPaneKey).toBeNull()
  })

  it('marks sidebar activity when the source worktree id is a path alias of the summary', () => {
    const canonical = 'repo::/remote/feature'
    const alias = 'repo::/remote/feature/'
    const pane = 'tab:leaf'
    const summaries = new Map([[canonical, summary(canonical)]])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([[pane, workingSource(pane, alias)]]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: {},
      getSummary: (id) =>
        id === alias || id === canonical ? (summaries.get(canonical) ?? null) : null
    })
    expect(summaries.get(canonical)).toMatchObject({
      hasHostSidebarActivity: true,
      status: 'working'
    })
    expect(summaries.get(canonical)?.agents).toHaveLength(1)
  })

  it('does not mark the coordinator busy when a mirrored child uses a path alias', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const parentId = 'folder:orca'
    const childId = 'folder:babysitter'
    const childAlias = 'folder:babysitter/'
    const summaries = new Map([
      [parentId, summary(parentId)],
      [childId, summary(childId)]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([
        [coordinator, source(coordinator, parentId, 'term_coord')],
        [worker, workingSource(worker, childAlias)]
      ]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: { [worker]: { parentPaneKey: coordinator } },
      getSummary: (id) => {
        if (id === parentId) {
          return summaries.get(parentId) ?? null
        }
        if (id === childId || id === childAlias) {
          return summaries.get(childId) ?? null
        }
        return null
      }
    })
    expect(summaries.get(parentId)?.agents.map((row) => row.paneKey)).toEqual([coordinator, worker])
    expect(summaries.get(parentId)?.hasHostSidebarActivity).toBe(false)
    expect(summaries.get(parentId)?.sidebarStatus).not.toBe('working')
    expect(summaries.get(childId)?.hasHostSidebarActivity).toBe(true)
  })

  it('does not give the coordinator a permission dot for a mirrored waiting worker', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const summaries = new Map([
      ['folder:orca', summary('folder:orca')],
      ['folder:babysitter', summary('folder:babysitter')]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([
        [coordinator, source(coordinator, 'folder:orca', 'term_coord')],
        [worker, { ...workingSource(worker, 'folder:babysitter'), state: 'waiting' }]
      ]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: { [worker]: { parentPaneKey: coordinator } },
      getSummary: (id) => summaries.get(id) ?? null
    })
    expect(summaries.get('folder:orca')?.sidebarStatus).toBe('inactive')
    expect(summaries.get('folder:orca')?.hasHostSidebarActivity).toBe(false)
    expect(summaries.get('folder:babysitter')?.sidebarStatus).toBe('permission')
  })

  it('mirrors a nested helper onto the coordinator, not only its parent worker', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const helper = 'tab-helper:leaf-helper'
    const summaries = new Map([
      ['folder:orca', summary('folder:orca')],
      ['folder:worker', summary('folder:worker')],
      ['folder:helper', summary('folder:helper')]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([
        [coordinator, source(coordinator, 'folder:orca', 'term_coord')],
        [worker, source(worker, 'folder:worker', 'term_worker')],
        [helper, source(helper, 'folder:helper', 'term_helper')]
      ]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: {
        [worker]: { parentPaneKey: coordinator },
        [helper]: { parentPaneKey: worker }
      },
      getSummary: (id) => summaries.get(id) ?? null
    })
    expect(summaries.get('folder:orca')?.agents.map((row) => row.paneKey)).toEqual([
      coordinator,
      worker,
      helper
    ])
    expect(summaries.get('folder:worker')?.agents.map((row) => row.paneKey)).toEqual([
      worker,
      helper
    ])
    expect(summaries.get('folder:orca')?.hasHostSidebarActivity).toBe(false)
  })

  it('mirrors onto a parent whose source id is a path alias', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const parentId = 'folder:orca'
    const parentAlias = 'folder:orca/'
    const summaries = new Map([
      [parentId, summary(parentId)],
      ['folder:babysitter', summary('folder:babysitter')]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([
        [coordinator, source(coordinator, parentAlias, 'term_coord')],
        [worker, source(worker, 'folder:babysitter', 'term_worker')]
      ]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: { [worker]: { parentPaneKey: coordinator } },
      getSummary: (id) =>
        id === parentId || id === parentAlias
          ? (summaries.get(parentId) ?? null)
          : (summaries.get(id) ?? null)
    })
    expect(summaries.get(parentId)?.agents.map((row) => row.paneKey)).toEqual([coordinator, worker])
  })

  it('keeps a nested helper home id when the helper is mirrored onto the coordinator', () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const helper = 'tab-helper:leaf-helper'
    const babysitter = summary('folder:babysitter')
    babysitter.hostId = 'runtime:worker'
    const summaries = new Map([
      ['folder:orca', summary('folder:orca')],
      ['folder:babysitter', babysitter]
    ])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: new Map([
        [coordinator, source(coordinator, 'folder:orca', 'term_coord')],
        [worker, source(worker, 'folder:babysitter', 'term_worker')],
        [helper, source(helper, 'folder:babysitter', 'term_helper')]
      ]),
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: {
        [worker]: { parentPaneKey: coordinator },
        [helper]: { parentPaneKey: worker }
      },
      getSummary: (id) => summaries.get(id) ?? null
    })
    const mirrored = summaries.get('folder:orca')?.agents.find((row) => row.paneKey === helper)
    expect(mirrored?.homeWorktreeId).toBe('folder:babysitter')
    expect(mirrored?.homeHostId).toBe('runtime:worker')
    expect(summaries.get('folder:orca')?.agents.map((row) => row.paneKey)).toEqual([
      coordinator,
      worker,
      helper
    ])
  })
})
