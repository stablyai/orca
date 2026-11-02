import { describe, expect, it } from 'vitest'
import { buildRuntimeSmartSortSources } from './runtime-smart-sort-sources'

describe('buildRuntimeSmartSortSources', () => {
  it('rebuilds tabs, live bindings, pane titles and layouts from runtime records', () => {
    const sources = buildRuntimeSmartSortSources({
      tabs: [
        { tabId: 'tab-1', worktreeId: 'wt-a', title: 'zsh', activeLeafId: 'leaf-1', layout: null }
      ],
      leaves: [
        { tabId: 'tab-1', ptyId: 'pty-1', connected: true, paneRuntimeId: 1, paneTitle: 'claude' },
        { tabId: 'tab-1', ptyId: 'pty-2', connected: false, paneRuntimeId: 2, paneTitle: null },
        { tabId: 'tab-1', ptyId: 'pty-3', connected: false, paneRuntimeId: 3, paneTitle: null }
      ],
      sessionTabs: [
        [
          'wt-b',
          {
            tabs: [
              {
                type: 'terminal',
                id: 'tab-2::leaf',
                title: 'slept',
                parentTabId: 'tab-2',
                leafId: 'leaf',
                isActive: false
              }
            ]
          }
        ],
        // A mounted tab listed again by its session snapshot is not counted twice.
        [
          'wt-a',
          {
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::leaf-1',
                title: 'zsh',
                parentTabId: 'tab-1',
                leafId: 'leaf-1',
                isActive: true
              }
            ]
          }
        ]
      ],
      isUnverifiablePty: (ptyId) => ptyId === 'pty-3',
      agentStatusByPaneKey: {},
      migrationUnsupported: []
    })
    expect(sources.tabsByWorktree).toEqual({
      'wt-a': [{ id: 'tab-1', title: 'zsh' }],
      'wt-b': [{ id: 'tab-2', title: 'slept' }]
    })
    // A binding whose host only lost contact stays live, as it does in the window.
    expect(sources.ptyIdsByTabId).toEqual({ 'tab-1': ['pty-1', 'pty-3'] })
    expect(sources.runtimePaneTitlesByTabId).toEqual({ 'tab-1': { 1: 'claude' } })
    expect(sources.terminalLayoutsByTabId?.['tab-1']).toMatchObject({
      root: null,
      activeLeafId: 'leaf-1'
    })
  })
})
