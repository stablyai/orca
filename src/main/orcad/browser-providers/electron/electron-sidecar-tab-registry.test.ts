import { expect, it } from 'vitest'
import { ElectronSidecarTabRegistry } from './electron-sidecar-tab-registry'

it('reports the worktree orcad tracks for sidecar tabs, popups and profile results', () => {
  const tabs = new ElectronSidecarTabRegistry()
  tabs.register('sidecar-page', 'public-page', 'workspace-a')

  expect(
    tabs.reconcileTabs([
      { browserPageId: 'sidecar-page', worktreeId: null },
      { browserPageId: 'popup', openerBrowserPageId: 'sidecar-page', worktreeId: null },
      { browserPageId: 'unscoped', worktreeId: null }
    ])
  ).toEqual([
    { browserPageId: 'public-page', worktreeId: 'workspace-a', index: 0 },
    {
      browserPageId: 'popup',
      openerBrowserPageId: 'public-page',
      worktreeId: 'workspace-a',
      index: 1
    },
    { browserPageId: 'unscoped', worktreeId: null, index: 2 }
  ])
  expect(
    tabs.rewriteResult({ browserPageId: 'sidecar-page', worktreeId: null, profileId: 'default' })
  ).toEqual({ browserPageId: 'public-page', worktreeId: 'workspace-a', profileId: 'default' })
})
