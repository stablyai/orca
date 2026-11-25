import { beforeEach, describe, expect, it } from 'vitest'
import { mergeHostBotListing, type HostBotListing } from '../../bots/host-bot-listing'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../../src/shared/bots/bot-sidebar-view'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import {
  advanceHostListDeleteClaim,
  findHostListDeleteRow,
  hostListBotHomes,
  requestHostListDelete,
  resetHostListDeleteIntentForTest,
  takeHostListDeleteIntent,
  type HostListDeleteView
} from './host-list-delete-intent'

type Row = Pick<Worktree, 'worktreeId' | 'hostId' | 'botHome' | 'isMainWorktree'>

const COMPLETE = { homes: new Set<string>(), complete: true }

// A spent, stale, misdirected or superseded intent would open a delete confirm the user never asked for.
describe('host list delete intent', () => {
  const target = { hostId: 'desk', owner: 'local', worktreeId: 'repo::/a' } as const
  const rowA: Row = { worktreeId: 'repo::/a', hostId: 'local' }
  const rowB: Row = { worktreeId: 'repo::/b', hostId: 'local' }
  const view = (over: Partial<HostListDeleteView<Row>>): HostListDeleteView<Row> => ({
    token: '',
    hostId: 'desk',
    pathname: '/h/desk',
    connected: true,
    busy: false,
    rows: [],
    homes: COMPLETE,
    now: 1_000,
    ...over
  })
  const held = (claimTarget: Parameters<typeof requestHostListDelete>[0] = target) =>
    advanceHostListDeleteClaim(null, view({ token: requestHostListDelete(claimTarget, 0) })).claim
  beforeEach(resetHostListDeleteIntentForTest)

  it('is spent by the first presented token, only for its own host, within the tap deadline', () => {
    const token = requestHostListDelete(target, 0)
    expect(takeHostListDeleteIntent('other', 'desk', '/h/desk', 0)).toBeNull()
    expect(takeHostListDeleteIntent(token, 'desk', '/h/desk', 0)?.deadline).toBe(10_000)
    expect(takeHostListDeleteIntent(token, 'desk', '/h/desk', 0)).toBeNull()
    const wrongHost = requestHostListDelete(target, 0)
    expect(takeHostListDeleteIntent(wrongHost, 'laptop', '/h/laptop', 0)).toBeNull()
    expect(takeHostListDeleteIntent(wrongHost, 'desk', '/h/desk', 0)).toBeNull()
  })

  it('keeps the tap deadline: a row arriving after it never opens', () => {
    const token = requestHostListDelete(target, 0)
    const taken = advanceHostListDeleteClaim(null, view({ token, now: 9_000 }))
    expect(taken.step.kind).toBe('wait')
    const late = advanceHostListDeleteClaim(taken.claim, view({ rows: [rowA], now: 10_001 }))
    expect(late).toEqual({ claim: null, step: { kind: 'notFound' } })
  })

  it('lets a new tap replace a held claim before the old row can open', () => {
    const old = held()
    const next = requestHostListDelete({ ...target, worktreeId: 'repo::/b' }, 0)
    const pass = advanceHostListDeleteClaim(old, view({ token: next, rows: [rowA, rowB] }))
    expect(pass.step).toEqual({ kind: 'open', row: rowB })
  })

  it('opens only the row on the session checkout host, only while connected, never a primary', () => {
    const claim = held()
    expect(
      advanceHostListDeleteClaim(claim, view({ connected: false, rows: [rowA] })).step.kind
    ).toBe('wait')
    const twin: Row = { worktreeId: 'repo::/a', hostId: 'ssh:box' }
    expect(advanceHostListDeleteClaim(claim, view({ rows: [twin] })).step.kind).toBe('wait')
    expect(findHostListDeleteRow([rowA, { ...rowA }], target)).toBeNull()
    expect(
      advanceHostListDeleteClaim(claim, view({ rows: [{ ...rowA, isMainWorktree: true }] }))
    ).toEqual({ claim: null, step: { kind: 'primary' } })
  })

  it("admits a folder only once this host's bot and group homes are currently known", () => {
    const folder = { hostId: 'desk', owner: 'local', worktreeId: 'folder:f1' } as const
    const folderRow: Row = { worktreeId: 'folder:f1', hostId: 'local' }
    const claim = held(folder)
    const step = (listings: readonly HostBotListing[], groupsSupported = true) =>
      advanceHostListDeleteClaim(
        claim,
        view({ rows: [folderRow], homes: hostListBotHomes(listings, groupsSupported) })
      ).step.kind
    const base: HostBotListing = {
      kind: 'listed',
      hostId: 'local',
      hostLabel: 'Desk',
      bots: [],
      hideBotCreated: false,
      view: DEFAULT_BOT_SIDEBAR_VIEW,
      workspaceLineage: {},
      worktreeLineage: {}
    }
    const failed: HostBotListing = { kind: 'read-failed', hostId: 'local', hostLabel: 'Desk' }
    const fresh: HostBotListing = { ...base, groups: [], groupsFresh: true }
    const home = {
      id: 'b1',
      name: 'Bot',
      folderWorkspaceId: 'f1',
      avatar: null,
      paused: false,
      chatSessionId: null
    }
    // Eligible control: bots and groups both read now, and f1 is neither.
    expect(step([fresh])).toBe('open')
    // Cold: bots listed but the groups read failed.
    expect(step([base])).toBe('wait')
    // A host without groups needs only its bots.
    expect(step([base], false)).toBe('open')
    // Retained groups can't prove a Home made since; a failed read makes the whole listing stale.
    const kept = mergeHostBotListing([fresh], 'local', base, true)
    expect(step(kept)).toBe('wait')
    expect(step(mergeHostBotListing([fresh], 'local', failed, true))).toBe('wait')
    // A Home known from any read, however old, still refuses.
    const withHome = mergeHostBotListing([{ ...fresh, bots: [home] }], 'local', failed, true)
    expect(step(withHome)).toBe('notFound')
    expect(
      advanceHostListDeleteClaim(claim, view({ rows: [{ ...folderRow, botHome: true }] })).step.kind
    ).toBe('notFound')
  })
})
