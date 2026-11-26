import { describe, expect, it } from 'vitest'
import {
  pluginWorkspaceTerminal,
  projectPluginWorkspaceAgents
} from './plugin-workspace-projection'

const restored = {
  handle: 'term_restored',
  title: 'claude',
  tabId: 'pty:p1',
  leafId: 'pty:p1',
  recordedPaneKey: 'tab1:leaf1'
}
const row = {
  paneKey: 'tab1:leaf1',
  worktreeId: 'wt1',
  terminalHandle: 'term_before_restart',
  state: 'done' as const,
  stateStartedAt: 1
}

describe('projectPluginWorkspaceAgents', () => {
  it('names an unshown restored terminal by its recorded pane, unless a shown terminal holds it or another restored one claims it', () => {
    const terminalIds = (terminals: (typeof restored)[]) =>
      projectPluginWorkspaceAgents('wt1', terminals.map(pluginWorkspaceTerminal), [row]).map(
        (agent) => agent.terminalId
      )

    expect(terminalIds([restored])).toEqual(['term_restored'])
    expect(
      terminalIds([restored, { ...restored, handle: 'term_shown', tabId: 'tab1', leafId: 'leaf1' }])
    ).toEqual(['term_shown'])
    expect(terminalIds([restored, { ...restored, handle: 'term_other' }])).toEqual([null])
  })
})
