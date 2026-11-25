import { beforeEach, describe, expect, it } from 'vitest'
import {
  markHostBotListingRefreshing,
  mergeHostBotListing,
  type HostBotListing
} from '../../bots/host-bot-listing'
import { readHostBotListing } from '../../bots/use-host-bots'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import { createFakeRpcClient } from '../../mobile-web-shell/test-support/bridge-host-test-fakes'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
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

let reads = 0
// Answers the reads a bot listing makes; any other method is refused, as an older host's would be.
function answeringClient(host: { botsEnabled: boolean; groups: unknown }) {
  const results: Record<string, unknown> = {
    'status.get': { capabilities: [BOTS_MOBILE_RUNTIME_CAPABILITY] },
    'bots.list': { bots: [], botsEnabled: host.botsEnabled, hideBotCreatedWorkspaces: false },
    'worktree.lineageList': { lineage: {}, workspaceLineage: {} },
    'bots.groups.list': host.groups
  }
  return {
    ...createFakeRpcClient(),
    sendRequest: async (method: string): Promise<RpcResponse> =>
      results[method] != null
        ? { id: method, ok: true, result: results[method] }
        : { id: method, ok: false, error: { code: 'method_not_found', message: method } }
  }
}

// A spent, stale, misdirected or superseded intent would open a delete confirm the user never asked for.
describe('host list delete intent', () => {
  const target = { hostId: 'desk', owner: 'local', worktreeId: 'repo::/a' } as const
  const rowA: Row = { worktreeId: 'repo::/a', hostId: 'local' }
  const rowB: Row = { worktreeId: 'repo::/b', hostId: 'local' }
  const view = (over: Partial<HostListDeleteView<Row>>): HostListDeleteView<Row> => ({
    token: '',
    hostId: 'desk',
    pathname: '/h/desk',
    search: '',
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

  it("admits a folder only once this host's latest read proves it is no Home", async () => {
    const folder = { hostId: 'desk', owner: 'local', worktreeId: 'folder:f1' } as const
    const folderRow: Row = { worktreeId: 'folder:f1', hostId: 'local' }
    const claim = held(folder)
    const step = (listings: readonly HostBotListing[]) =>
      advanceHostListDeleteClaim(
        claim,
        view({ rows: [folderRow], homes: hostListBotHomes(listings) })
      ).step.kind
    // The real read, over a host that answers as configured.
    const read = async (botsEnabled: boolean, groups: unknown) => {
      const listing = await readHostBotListing(
        {
          hostId: 'local',
          hostLabel: 'Desk',
          client: answeringClient({ botsEnabled, groups }),
          key: `k${++reads}`,
          relaysCreate: true
        },
        false
      )
      if (listing?.kind !== 'listed') {
        throw new Error(`unlisted: ${listing?.kind}`)
      }
      return listing
    }
    const on = await read(true, { groups: [] })
    // Ordinary non-Home control: Bots on, groups answered, f1 is neither.
    expect(step([on])).toBe('open')
    // Bots off: the host answers an empty, filtered group list while it keeps stored groups.
    expect(step([await read(false, { groups: [] })])).toBe('wait')
    // Cold: bots listed but the groups read failed or isn't served.
    expect(step([await read(true, null)])).toBe('wait')
    // A newer read out: the last negative can miss a Home made since, until that read lands.
    const refreshing = markHostBotListingRefreshing([on], 'local')
    expect(step(refreshing)).toBe('wait')
    expect(step(mergeHostBotListing(refreshing, 'local', on, true))).toBe('open')
    // Retained groups, or a failed read, can't prove it either.
    expect(step(mergeHostBotListing([on], 'local', await read(true, null), true))).toBe('wait')
    const failed: HostBotListing = { kind: 'read-failed', hostId: 'local', hostLabel: 'Desk' }
    expect(step(mergeHostBotListing([on], 'local', failed, true))).toBe('wait')
    // A Home known from any read, however old, still refuses.
    const home = {
      id: 'b1',
      name: 'Bot',
      folderWorkspaceId: 'f1',
      avatar: null,
      paused: false,
      chatSessionId: null
    }
    expect(step(mergeHostBotListing([{ ...on, bots: [home] }], 'local', failed, true))).toBe(
      'notFound'
    )
    expect(
      advanceHostListDeleteClaim(claim, view({ rows: [{ ...folderRow, botHome: true }] })).step.kind
    ).toBe('notFound')
  })

  it('drops a held claim once the list search changes', () => {
    const claim = held()
    expect(advanceHostListDeleteClaim(claim, view({ search: 'x', rows: [rowA] })).step.kind).toBe(
      'none'
    )
  })
})
