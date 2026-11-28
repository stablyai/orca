// A teammate's saved list in a shared agent's Home, read back as the profile stores it: rows saved
// before files, terminals and pages read as their chats; a row of a newer build keeps what it can read.
import { expect, it } from 'vitest'
import { normalizePersistedMobileClientTabSelections } from '../../client/navigation/client-session-tab-selection-persistence'
import { PersonSessionTabLists } from './person-session-tab-lists'

const MATE = 'teammate:bot-1:usr_mate'
const HOME = 'folder:home'

/** The lists a saved field reads back as, through the same normalize and hydrate a start runs. */
function readBack(saved: unknown) {
  const lists = new PersonSessionTabLists(() => {})
  lists.hydrate(normalizePersistedMobileClientTabSelections(saved))
  return lists.serialize()[MATE]?.[HOME]
}

it('reads a row saved before files, terminals and pages as its chats, in order', () => {
  const row = readBack({
    [MATE]: { [HOME]: { activeTabId: 'agent-session:c2', personTabs: ['c1', 'c2'] } }
  })
  expect(row?.personTabList).toEqual([
    { kind: 'chat', sessionId: 'c1' },
    { kind: 'chat', sessionId: 'c2' }
  ])
  expect(row?.activeTabId).toBe('agent-session:c2')
})

it('keeps every tab of a whole list in order, round trip, and drops one it cannot read', () => {
  const tabs = [
    { kind: 'terminal', parentTabId: 't1', leafId: 'l1', ptyId: 'pty-1' },
    { kind: 'chat', sessionId: 'c1' },
    { kind: 'browser', browserPageId: 'page-1' },
    {
      kind: 'file',
      relativePath: 'a.md',
      filePath: '/home/a.md',
      mode: 'diff',
      diffSource: 'staged'
    }
  ]
  const row = readBack({
    [MATE]: {
      [HOME]: {
        activeTabId: 'page-1',
        personTabs: ['c1'],
        personTabList: [...tabs.slice(0, 2), { kind: 'hologram' }, ...tabs.slice(2)]
      }
    }
  })
  expect(row?.personTabList).toEqual(tabs)
  expect(row?.personTabs).toEqual(['c1'])
  expect(readBack({ [MATE]: { [HOME]: row } })).toEqual(row)
})
