import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { composeDesktopOwnedSessionTabs } from './desktop-owned-session-tabs'

function terminal(parentTabId: string, leaf: string, isActive = false) {
  return { type: 'terminal', id: `${parentTabId}::${leaf}`, parentTabId, isActive }
}

function browser(id: string) {
  return { type: 'browser', id, browserWorkspaceId: id, isActive: false }
}

function editor(id: string, filePath: string, type: 'file' | 'markdown' = 'file') {
  return { type, id, filePath, isActive: false }
}

function server(tabs: unknown[], activeTabId: string | null = null) {
  return {
    type: 'snapshot',
    worktree: 'w',
    publicationEpoch: 'headless:1',
    snapshotVersion: 4,
    activeTabId,
    activeTabType: activeTabId ? 'terminal' : null,
    tabs
  }
}

function desktop(tabs: unknown[], desktopTabOrder: string[], activeTabId: string | null = null) {
  return {
    worktree: 'w',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 2,
    activeTabId,
    activeTabType: activeTabId ? 'file' : null,
    tabGroups: [{ id: 'g', activeTabId, tabOrder: tabs.map(() => ''), desktopTabOrder }],
    tabs
  }
}

const ids = (result: unknown) =>
  z
    .looseObject({ tabs: z.array(z.looseObject({ id: z.string() })) })
    .parse(result)
    .tabs.map((tab) => tab.id)

describe("a server workspace's strip with the desktop's own tabs", () => {
  it('places each desktop tab where the desktop shows it, after every pane of a split terminal', () => {
    const { result, desktopTabIds } = composeDesktopOwnedSessionTabs(
      server([terminal('t1', 'a'), terminal('t1', 'b'), browser('p1')]),
      desktop([editor('e1', '/a.ts'), editor('e2', '/b.md', 'markdown')], ['e1', 't1', 'e2', 'p1'])
    )

    expect(ids(result)).toEqual(['e1', 't1::a', 't1::b', 'e2', 'p1'])
    expect([...desktopTabIds]).toEqual(['e1', 'e2'])
  })

  it('keeps tabs the desktop order does not name: server ones in place, desktop ones last', () => {
    const { result } = composeDesktopOwnedSessionTabs(
      server([terminal('t1', 'a'), terminal('new', 'a')]),
      desktop([editor('e1', '/a.ts'), editor('e2', '/b.ts')], ['t1', 'e1'])
    )

    expect(ids(result)).toEqual(['t1::a', 'e1', 'new::a', 'e2'])
  })

  it("lists an editor tab the server persisted once, as the desktop's", () => {
    const { result, desktopTabIds } = composeDesktopOwnedSessionTabs(
      server([editor('server-readme', '/README.md', 'markdown'), terminal('t1', 'a')]),
      desktop([editor('desktop-readme', '/README.md', 'markdown')], ['desktop-readme', 't1'])
    )

    expect(ids(result)).toEqual(['desktop-readme', 't1::a'])
    expect(desktopTabIds.has('desktop-readme')).toBe(true)
  })

  it("shows the phone's own last pick, on whichever host it was made", () => {
    const serverFrame = server([terminal('t1', 'a', true)], 't1::a')
    const desktopFrame = desktop([editor('e1', '/a.ts')], ['t1', 'e1'], 'e1')

    expect(composeDesktopOwnedSessionTabs(serverFrame, desktopFrame).result).toMatchObject({
      activeTabId: 't1::a',
      tabs: [
        { id: 't1::a', isActive: true },
        { id: 'e1', isActive: false }
      ]
    })
    expect(composeDesktopOwnedSessionTabs(serverFrame, desktopFrame, true).result).toMatchObject({
      activeTabId: 'e1',
      activeTabType: 'file',
      tabs: [
        { id: 't1::a', isActive: false },
        { id: 'e1', isActive: true }
      ]
    })
    // With nothing picked on the server, the desktop's pick shows either way.
    expect(
      composeDesktopOwnedSessionTabs(server([]), desktop([editor('e1', '/a.ts')], ['e1'], 'e1'))
        .result
    ).toMatchObject({ activeTabId: 'e1', tabs: [{ id: 'e1', isActive: true }] })
  })

  it("reads as newer when either side changes, and keeps the server's stream fields", () => {
    const before = composeDesktopOwnedSessionTabs(server([]), desktop([], [])).result
    const after = composeDesktopOwnedSessionTabs(server([]), {
      ...desktop([], []),
      snapshotVersion: 3
    }).result

    expect(before).toMatchObject({
      type: 'snapshot',
      worktree: 'w',
      publicationEpoch: 'headless:1|desktop:renderer:1',
      snapshotVersion: 6
    })
    expect(after).toMatchObject({ snapshotVersion: 7 })
  })

  it('composes a desktop with no strip to give as an empty one, under one epoch', () => {
    const serverFrame = server([terminal('t1', 'a')])
    const empty = composeDesktopOwnedSessionTabs(serverFrame, { type: 'end' })

    expect(empty.result).toMatchObject({
      publicationEpoch: 'headless:1|desktop:',
      snapshotVersion: 4,
      tabs: [{ id: 't1::a' }]
    })
    expect(composeDesktopOwnedSessionTabs(serverFrame, undefined).result).toEqual(empty.result)
    expect(empty.desktopTabIds.size).toBe(0)
  })

  it('passes a server frame that is not a strip through untouched', () => {
    expect(composeDesktopOwnedSessionTabs({ type: 'end' }, desktop([], [])).result).toEqual({
      type: 'end'
    })
  })
})
