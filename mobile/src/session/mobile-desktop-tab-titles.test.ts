import { describe, expect, it } from 'vitest'
import {
  mobileDesktopTabTitlesEqual,
  readMobileDesktopTabTitles
} from './mobile-desktop-tab-titles'

function pane(handle = 'cursor-1', tabId = 'tab-1', leafId = 'leaf-1') {
  return { type: 'terminal' as const, handle, tabId, leafId }
}

function inventory(title: string | null = 'Fix tab titles') {
  return {
    terminals: [{ ...pane(), title: '⠹ Cursor Agent', agentIdentity: 'cursor' }],
    visualLayouts: [
      {
        worktreeId: 'workspace-1',
        root: { type: 'group', tabs: [{ tabId: 'tab-1', title, panes: pane() }] }
      }
    ]
  }
}

describe('saved desktop tab titles', () => {
  it('reads the saved task name instead of the raw Cursor OSC title', () => {
    expect(readMobileDesktopTabTitles(inventory(), 'workspace-1').get('cursor-1')).toEqual({
      title: 'Fix tab titles',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      agentIdentity: 'cursor'
    })
  })

  it('walks split groups and panes without changing their terminal identities', () => {
    const first = pane()
    const second = pane('cursor-2', 'tab-1', 'leaf-2')
    const third = pane('cursor-3', 'tab-2', 'leaf-3')
    const titles = readMobileDesktopTabTitles(
      {
        terminals: [first, second, third],
        visualLayouts: [
          {
            worktreeId: 'workspace-1',
            root: {
              type: 'split',
              first: {
                type: 'group',
                tabs: [
                  {
                    tabId: 'tab-1',
                    title: 'First task',
                    panes: {
                      type: 'pane-split',
                      first,
                      second
                    }
                  }
                ]
              },
              second: {
                type: 'group',
                tabs: [{ tabId: 'tab-2', title: 'Other task', panes: third }]
              }
            }
          }
        ]
      },
      'workspace-1'
    )
    expect(titles.get('cursor-1')?.title).toBe('First task')
    expect(titles.get('cursor-2')).toMatchObject({ title: 'First task', leafId: 'leaf-2' })
    expect(titles.get('cursor-3')?.title).toBe('Other task')
  })

  it('ignores another workspace and stale layout leaves', () => {
    expect(readMobileDesktopTabTitles(inventory(), 'workspace-2').size).toBe(0)
    const stale = inventory()
    stale.terminals[0].leafId = 'replacement-leaf'
    expect(readMobileDesktopTabTitles(stale, 'workspace-1').size).toBe(0)
    stale.terminals[0].leafId = 'leaf-1'
    stale.terminals[0].tabId = 'replacement-tab'
    expect(readMobileDesktopTabTitles(stale, 'workspace-1').size).toBe(0)
  })

  it('does not resurrect a handle absent from the current inventory', () => {
    const stale = inventory()
    stale.terminals = []
    expect(readMobileDesktopTabTitles(stale, 'workspace-1').size).toBe(0)
  })

  it('accepts older hosts without layouts and skips malformed optional rows', () => {
    for (const reply of [
      null,
      {},
      { terminals: [] },
      { terminals: [], visualLayouts: 'invalid' }
    ]) {
      expect(readMobileDesktopTabTitles(reply, 'workspace-1').size).toBe(0)
    }
    const valid = inventory()
    expect(
      readMobileDesktopTabTitles(
        {
          terminals: [null, ...valid.terminals],
          visualLayouts: [
            null,
            { worktreeId: 'workspace-1', root: 'invalid' },
            ...valid.visualLayouts
          ]
        },
        'workspace-1'
      ).get('cursor-1')?.title
    ).toBe('Fix tab titles')
  })

  it('carries an explicit cleared title so the UI can release its saved name', () => {
    expect(
      readMobileDesktopTabTitles(inventory(null), 'workspace-1').get('cursor-1')?.title
    ).toBeNull()
  })

  it('detects rename and identity changes but ignores fresh copies of unchanged metadata', () => {
    const first = readMobileDesktopTabTitles(inventory(), 'workspace-1')
    expect(
      mobileDesktopTabTitlesEqual(first, readMobileDesktopTabTitles(inventory(), 'workspace-1'))
    ).toBe(true)
    expect(
      mobileDesktopTabTitlesEqual(
        first,
        readMobileDesktopTabTitles(inventory('New name'), 'workspace-1')
      )
    ).toBe(false)
    expect(mobileDesktopTabTitlesEqual(first, new Map())).toBe(false)
    const changed = inventory()
    changed.terminals[0].agentIdentity = 'claude'
    expect(
      mobileDesktopTabTitlesEqual(first, readMobileDesktopTabTitles(changed, 'workspace-1'))
    ).toBe(false)
  })
})
