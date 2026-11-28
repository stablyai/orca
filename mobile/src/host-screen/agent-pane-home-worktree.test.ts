import { describe, expect, it } from 'vitest'
import { homeWorktreeForAgentPane } from './agent-pane-home-worktree'

function card(worktreeId: string, panes: [string, string | null][]) {
  return {
    worktreeId,
    agents: panes.map(([paneKey, parentPaneKey]) => ({ paneKey, parentPaneKey }))
  }
}

describe('homeWorktreeForAgentPane', () => {
  it('opens a mirrored worker in its own workspace, not the coordinator card', () => {
    const coordinator = 'tab-coord:leaf'
    const worker = 'tab-worker:leaf'
    const orca = card('folder:orca', [
      [coordinator, null],
      [worker, coordinator]
    ])
    const babysitter = card('folder:babysitter', [[worker, coordinator]])
    expect(homeWorktreeForAgentPane([orca, babysitter], worker, orca).worktreeId).toBe(
      'folder:babysitter'
    )
    expect(homeWorktreeForAgentPane([orca, babysitter], coordinator, orca).worktreeId).toBe(
      'folder:orca'
    )
  })

  it('keeps a same-workspace child on that card', () => {
    const cardOnly = card('folder:orca', [
      ['parent', null],
      ['child', 'parent']
    ])
    expect(homeWorktreeForAgentPane([cardOnly], 'child', cardOnly).worktreeId).toBe('folder:orca')
  })

  it('opens a helper in its stamped home when the parent is mirrored onto the same cards', () => {
    const coordinator = 'tab-coord:leaf'
    const worker = 'tab-worker:leaf'
    const helper = 'tab-helper:leaf'
    const orca = {
      worktreeId: 'folder:orca',
      agents: [
        { paneKey: coordinator, parentPaneKey: null, homeWorktreeId: 'folder:orca' },
        { paneKey: worker, parentPaneKey: coordinator, homeWorktreeId: 'folder:babysitter' },
        { paneKey: helper, parentPaneKey: worker, homeWorktreeId: 'folder:babysitter' }
      ]
    }
    const babysitter = {
      worktreeId: 'folder:babysitter',
      agents: [
        { paneKey: worker, parentPaneKey: coordinator, homeWorktreeId: 'folder:babysitter' },
        { paneKey: helper, parentPaneKey: worker, homeWorktreeId: 'folder:babysitter' }
      ]
    }
    expect(homeWorktreeForAgentPane([orca, babysitter], helper, orca).worktreeId).toBe(
      'folder:babysitter'
    )
  })

  it('opens the stamped host when two cards share the workspace id', () => {
    const helper = 'tab-helper:leaf'
    const coordinator = {
      worktreeId: 'repo::/feature',
      hostId: 'local',
      agents: [
        {
          paneKey: helper,
          parentPaneKey: 'tab-worker:leaf',
          homeWorktreeId: 'repo::/feature',
          homeHostId: 'runtime:worker'
        }
      ]
    }
    const worker = {
      worktreeId: 'repo::/feature',
      hostId: 'runtime:worker',
      agents: [
        {
          paneKey: helper,
          parentPaneKey: 'tab-worker:leaf',
          homeWorktreeId: 'repo::/feature',
          homeHostId: 'runtime:worker'
        }
      ]
    }
    expect(homeWorktreeForAgentPane([coordinator, worker], helper, coordinator).hostId).toBe(
      'runtime:worker'
    )
  })
})
