import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { fixture } from '../../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import {
  makeTerminalTab,
  TEST_LEAF_1,
  TEST_LEAF_2
} from '../../../persistence/persistence-session-fixtures'
import { watchCrewRuntimeSources } from './crew-runtime-watch'

it('invalidates every naming input through workspace writes without copying buffers or split geometry', async () => {
  const { store } = await fixture()
  const session = getDefaultWorkspaceSession()
  const tab = makeTerminalTab({ id: 'tab', worktreeId: 'folder' })
  session.tabsByWorktree = { folder: [tab] }
  session.terminalLayoutsByTabId = {
    tab: {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: TEST_LEAF_1 },
        second: { type: 'leaf', leafId: TEST_LEAF_2 },
        ratio: 0.5
      },
      activeLeafId: null,
      expandedLeafId: null,
      titlesByLeafId: { [TEST_LEAF_1]: 'First' }
    }
  }
  store.setWorkspaceSession(session)
  const wake = vi.fn()
  const stop = watchCrewRuntimeSources(
    {
      store,
      watchChanges: () => () => {},
      watchTransitions: () => () => {},
      watchClient: () => () => {}
    },
    wake
  )
  try {
    for (const patch of [
      { quickCommandLabel: 'Command' },
      { generatedTitle: 'Generated' },
      { defaultTitle: 'Default' },
      { aiVaultTitle: { agent: 'codex' as const, sessionId: 'provider', title: 'Provider' } }
    ]) {
      const next = structuredClone(store.getWorkspaceSession())
      Object.assign(next.tabsByWorktree!.folder[0], patch)
      store.setWorkspaceSession(next)
      expect(wake.mock.calls.some(([facets]) => facets.has('names'))).toBe(true)
      wake.mockClear()
    }
    const next = structuredClone(store.getWorkspaceSession())
    const layout = next.terminalLayoutsByTabId!.tab
    if (layout.root?.type === 'split') {
      layout.root.ratio = 0.8
    }
    layout.buffersByLeafId = { [TEST_LEAF_1]: 'x'.repeat(100_000) }
    store.setWorkspaceSession(next)
    expect(wake.mock.calls.some(([facets]) => facets.has('names'))).toBe(false)
    const renamed = structuredClone(store.getWorkspaceSession())
    renamed.terminalLayoutsByTabId!.tab.titlesByLeafId![TEST_LEAF_1] = 'Renamed leaf'
    store.setWorkspaceSession(renamed)
    expect(wake.mock.calls.some(([facets]) => facets.has('names'))).toBe(true)
  } finally {
    stop()
  }
})
