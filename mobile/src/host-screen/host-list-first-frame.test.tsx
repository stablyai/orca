import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_INPUTS_SEMANTICS_VERSION } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import type { InstalledSidebarInputs } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-installer'
import type { RpcClient } from '../transport/rpc-client'
import type { Section } from '../worktree/workspace-list-types'
import type { SidebarFeedReaderRead } from '../../../src/shared/sidebar-feed-client/sidebar-feed-reader'
import { installSidebarFeedSnapshot } from '../../../src/shared/sidebar-feed-client/sidebar-feed-snapshot'
import { FEED_ROWS, liveRow, phoneView } from './host-sidebar-feed.test-fixture'

const readers = vi.hoisted((): { onRead: ((read: SidebarFeedReaderRead) => void)[] } => ({
  onRead: []
}))

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('../../../src/shared/sidebar-feed-client/sidebar-feed-reader', () => ({
  SidebarFeedReader: class {
    constructor(
      _transport: unknown,
      _options: unknown,
      onRead: (read: SidebarFeedReaderRead) => void
    ) {
      readers.onRead.push(onRead)
    }
    refresh(): void {}
    changed(): void {}
    dispose(): void {}
  }
}))
vi.mock('./use-host-repo-icon-data-urls', () => ({ useHostRepoIconDataUrls: () => new Map() }))
vi.mock('../worktree/use-last-visited-worktree-on-host', () => ({
  useLastVisitedWorktreeOnHost: () => ({ kind: 'none' })
}))

import { useHostListSections } from './use-host-list-sections'
import type { HostScreenState } from './use-host-screen-state'
import { forgetRememberedSidebarFeeds, useHostSidebarFeed } from './use-host-sidebar-feed'

/** worktree.ps's rows: flat, unpinned, in its own order — not the shape the desktop draws. */
const LISTED = [
  liveRow({ worktreeId: 'lab::/w/gpu', repoId: 'lab', repo: 'lab', hostId: 'ssh:gpu' }),
  liveRow({ worktreeId: 'orca::/w/child' }),
  liveRow({ worktreeId: 'orca::/w/parent' })
]

const INSTALLED: InstalledSidebarInputs = {
  generation: 'g',
  revision: 1,
  schemaVersion: 1,
  semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
  domains: new Map([
    [
      'workspaces',
      new Map<string, unknown>([
        ['|orca::/w/parent', FEED_ROWS.parent],
        ['|orca::/w/child', FEED_ROWS.child]
      ])
    ]
  ])
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list builder reads only these fields.
const STATE = {
  view: phoneView(),
  search: '',
  servedProjectSections: null,
  desktopRepos: [],
  hostProjectGroups: [],
  repoHostIdByRepoId: new Map(),
  pinnedIds: [],
  showPinnedInGroups: false
} as unknown as HostScreenState

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked reader never sends.
const CLIENT = {} as RpcClient

let drawn: Section[] = []
let kind = ''

function List({ hostId }: { hostId: string }) {
  const { feed } = useHostSidebarFeed(CLIENT, hostId)
  kind = feed.kind
  drawn = useHostListSections({
    client: CLIENT,
    hostId,
    feed,
    displayWorktrees: LISTED,
    hostPlatform: 'darwin',
    state: STATE
  }).sections
  return null
}

const renderers: ReactTestRenderer[] = []
async function open(hostId: string): Promise<void> {
  await act(async () => {
    renderers.push(create(createElement(List, { hostId })))
  })
}
const SNAPSHOT = installSidebarFeedSnapshot(INSTALLED, null)

async function read(next: Omit<SidebarFeedReaderRead, 'settledBy'>): Promise<void> {
  await act(async () => readers.onRead.at(-1)?.({ ...next, settledBy: null }))
}
const rowIds = () => drawn.flatMap((section) => section.data.map((row) => row.worktreeId))

describe("the host list's first frame under the feed", () => {
  beforeEach(() => {
    readers.onRead.length = 0
    forgetRememberedSidebarFeeds()
  })
  afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  })

  it('draws no rows from worktree.ps before the feed installs, then the desktop’s list', async () => {
    await open('host-1')
    expect(kind).toBe('loading')
    expect(drawn).toEqual([])
    await read({ snapshot: SNAPSHOT, unavailable: false })
    expect(drawn[0]?.icon).toBe('pin')
    expect(rowIds()).toContain('orca::/w/parent')
  })

  it("opens the list again on the host's last installed feed, not on worktree.ps", async () => {
    await open('host-1')
    await read({ snapshot: SNAPSHOT, unavailable: false })
    const desktopList = drawn
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))

    await open('host-1')
    expect(kind).toBe('ready')
    expect(drawn).toEqual(desktopList)
  })

  it("never opens one host's list on another's feed", async () => {
    await open('host-1')
    await read({ snapshot: SNAPSHOT, unavailable: false })
    await open('host-2')
    expect(kind).toBe('loading')
    expect(drawn).toEqual([])
  })

  it('still lists an older desktop that has no feed, from worktree.ps', async () => {
    await open('host-1')
    await read({ snapshot: null, unavailable: true })
    expect(kind).toBe('reopen')
    expect(rowIds()).toEqual(LISTED.map((row) => row.worktreeId))
  })

  it('forgets a feed the host stopped serving', async () => {
    await open('host-1')
    await read({ snapshot: SNAPSHOT, unavailable: false })
    await read({ snapshot: SNAPSHOT, unavailable: true })
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
    await open('host-1')
    expect(kind).toBe('loading')
  })
})
