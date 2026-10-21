// The rules a layout commit's merge adds to A2's (keep rows main lacks, and a running terminal),
// and the exit rule it shares with the window's publication path.
import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { withMainSessionTabRows, type MainSessionTabRows } from './main-session-tab-rows'

const WT = 'repo::/wt'
const NONE_EXITED = (): boolean => false

function terminal(id: string, ptyId?: string): RuntimeMobileSessionTerminalTab {
  const [parentTabId = id, leafId = id] = id.split('::')
  return {
    type: 'terminal',
    id,
    title: 'Terminal',
    parentTabId,
    leafId,
    isActive: false,
    ...(ptyId ? { ptyId } : {})
  }
}

function rows(tabs: RuntimeMobileSessionTerminalTab[]): MainSessionTabRows {
  return {
    worktree: WT,
    activeGroupId: 'g',
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'g', activeTabId: 't', tabOrder: [...new Set(tabs.map((t) => t.parentTabId))] }
    ],
    tabs
  }
}

const held = (tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot => ({
  ...rows(tabs),
  publicationEpoch: 'renderer',
  snapshotVersion: 4
})

describe('a layout commit merged into held rows (layout-owner build)', () => {
  it("keeps a terminal row main's layout lacks only when asked to", () => {
    const published = held([terminal('t::1'), terminal('u::1')])
    const projected = rows([terminal('t::1')])

    expect(withMainSessionTabRows(published, projected, NONE_EXITED).tabs.map((t) => t.id)).toEqual(
      ['t::1']
    )
    expect(
      withMainSessionTabRows(published, projected, NONE_EXITED, { keepUnlisted: true }).tabs.map(
        (t) => t.id
      )
    ).toEqual(['t::1', 'u::1'])
  })

  it('keeps a running terminal over a main binding that runs nowhere, given liveness', () => {
    const published = held([terminal('t::1', 'pty-new')])
    const projected = rows([terminal('t::1', 'pty-old')])
    const live = (ptyId: string): boolean => ptyId === 'pty-new'

    expect(withMainSessionTabRows(published, projected, NONE_EXITED).tabs[0]).toMatchObject({
      ptyId: 'pty-old'
    })
    expect(
      withMainSessionTabRows(published, projected, NONE_EXITED, { live }).tabs[0]
    ).toMatchObject({ ptyId: 'pty-new' })
    // Both running: main's binding is the newer word.
    expect(
      withMainSessionTabRows(published, projected, NONE_EXITED, { live: () => true }).tabs[0]
    ).toMatchObject({ ptyId: 'pty-old' })
  })

  it("window publication: the window's live terminal stands when main binds one the host saw exit", () => {
    const published = held([terminal('t::1', 'pty-live')])
    const projected = rows([terminal('t::1', 'pty-retired')])

    expect(
      withMainSessionTabRows(published, projected, (ptyId) => ptyId === 'pty-retired').tabs[0]
    ).toMatchObject({ ptyId: 'pty-live' })
  })

  it("keeps a kept pane's tab where it stood in its group, not in the active group", () => {
    const published: RuntimeMobileSessionTabsSnapshot = {
      ...held([terminal('t::1'), terminal('v::1'), terminal('u::1')]),
      activeGroupId: 'g1',
      tabGroups: [
        { id: 'g1', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'v', tabOrder: ['v', 'u'] }
      ]
    }
    const projected: MainSessionTabRows = {
      ...rows([terminal('t::1'), terminal('v::1')]),
      tabGroups: [
        { id: 'g1', activeTabId: 't', tabOrder: ['t'] },
        { id: 'g2', activeTabId: 'v', tabOrder: ['v'] }
      ]
    }

    const merged = withMainSessionTabRows(published, projected, NONE_EXITED, { keepUnlisted: true })

    expect(merged.tabGroups?.map((group) => group.tabOrder)).toEqual([['t'], ['v', 'u']])
  })
})
