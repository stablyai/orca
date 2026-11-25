import { beforeEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import {
  advanceHostListDeleteClaim,
  findHostListDeleteRow,
  requestHostListDelete,
  resetHostListDeleteIntentForTest,
  takeHostListDeleteIntent,
  type HostListDeleteView
} from './host-list-delete-intent'

type Row = Pick<Worktree, 'worktreeId' | 'hostId' | 'botHome'>

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
    overlayBusy: false,
    rows: [],
    homes: new Set(),
    now: 1_000,
    ...over
  })
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
    const held = advanceHostListDeleteClaim(
      null,
      view({ token: requestHostListDelete(target, 0) })
    ).claim
    const next = requestHostListDelete({ ...target, worktreeId: 'repo::/b' }, 0)
    const pass = advanceHostListDeleteClaim(held, view({ token: next, rows: [rowA, rowB] }))
    expect(pass.step).toEqual({ kind: 'open', row: rowB })
  })

  it('drops a held claim for good once the user opens another row or leaves the route', () => {
    const held = advanceHostListDeleteClaim(
      null,
      view({ token: requestHostListDelete(target, 0) })
    ).claim
    const manual = advanceHostListDeleteClaim(held, view({ overlayBusy: true, rows: [rowA] }))
    expect(manual).toEqual({ claim: null, step: { kind: 'none' } })
    expect(advanceHostListDeleteClaim(manual.claim, view({ rows: [rowA] })).step.kind).toBe('none')
    const moved = advanceHostListDeleteClaim(
      held,
      view({ pathname: '/h/desk/session/x', rows: [rowA] })
    )
    expect(moved.step.kind).toBe('none')
  })

  it('opens only an eligible row on the session checkout host, and only while connected', () => {
    const held = advanceHostListDeleteClaim(
      null,
      view({ token: requestHostListDelete(target, 0) })
    ).claim
    expect(
      advanceHostListDeleteClaim(held, view({ connected: false, rows: [rowA] })).step.kind
    ).toBe('wait')
    const twin: Row = { worktreeId: 'repo::/a', hostId: 'ssh:box' }
    expect(advanceHostListDeleteClaim(held, view({ rows: [twin] })).step.kind).toBe('wait')
    expect(findHostListDeleteRow([rowA, { ...rowA }], target)).toBeNull()
    const home: Row = { ...rowA, botHome: true }
    expect(advanceHostListDeleteClaim(held, view({ rows: [home] })).step.kind).toBe('notFound')

    const folder = { hostId: 'desk', owner: 'local', worktreeId: 'folder:f1' } as const
    const folderRow: Row = { worktreeId: 'folder:f1', hostId: 'local' }
    const folderClaim = advanceHostListDeleteClaim(
      null,
      view({ token: requestHostListDelete(folder, 0) })
    ).claim
    expect(
      advanceHostListDeleteClaim(folderClaim, view({ rows: [folderRow], homes: null })).step.kind
    ).toBe('wait')
    expect(
      advanceHostListDeleteClaim(
        folderClaim,
        view({ rows: [folderRow], homes: new Set(['folder:f1']) })
      ).step.kind
    ).toBe('notFound')
    expect(advanceHostListDeleteClaim(folderClaim, view({ rows: [folderRow] })).step.kind).toBe(
      'open'
    )
  })
})
