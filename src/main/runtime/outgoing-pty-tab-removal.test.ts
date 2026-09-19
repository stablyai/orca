import { expect, it } from 'vitest'
import { prepareOutgoingPtyTabRemoval } from './outgoing-pty-tab-removal'

function fixture() {
  const tab = {
    tabId: 'source',
    worktreeId: 'folder:source',
    title: 'Terminal',
    activeLeafId: null,
    layout: null
  }
  const tabs = new Map([
    ['source', tab],
    ['other', { ...tab, tabId: 'other' }]
  ])
  const leaves = new Map([['source-pane', { tabId: 'source', ptyId: 'source' }]])
  const cleanup = prepareOutgoingPtyTabRemoval(['source'], () => ({ tabs, leaves }))
  return { tab, tabs, leaves, cleanup }
}

it('removes only source-bound empty tabs after leaf removal, repeat-safely', () => {
  const { tabs, leaves, cleanup } = fixture()
  cleanup.removeEmpty()
  expect(tabs.has('source')).toBe(true)
  leaves.clear()
  cleanup.removeEmpty()
  cleanup.removeEmpty()
  expect([...tabs.keys()]).toEqual(['other'])
})

it('preserves a tab containing an unrelated leaf', () => {
  const { tab, tabs, leaves, cleanup } = fixture()
  leaves.set('other-pane', { tabId: 'source', ptyId: 'other' })
  leaves.delete('source-pane')
  cleanup.removeEmpty()
  expect(tabs.get('source')).toBe(tab)
})

it.each(['replacement', 'workspace'] as const)('refuses %s drift before deleting tabs', (kind) => {
  const { tab, tabs, leaves, cleanup } = fixture()
  if (kind === 'replacement') {
    tabs.set('source', { ...tab })
  } else {
    tab.worktreeId = 'folder:replacement'
  }
  leaves.clear()
  expect(cleanup.removeEmpty).toThrow('source_tab_changed')
  expect(tabs.has('source')).toBe(true)
  expect(tabs.has('other')).toBe(true)
})

it('refuses a recreated tab on repeat without deleting it', () => {
  const { tab, tabs, leaves, cleanup } = fixture()
  leaves.clear()
  cleanup.removeEmpty()
  const replacement = { ...tab }
  tabs.set('source', replacement)
  expect(cleanup.removeEmpty).toThrow('source_tab_changed')
  expect(tabs.get('source')).toBe(replacement)
})
