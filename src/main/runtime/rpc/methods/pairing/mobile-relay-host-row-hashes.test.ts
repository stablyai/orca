import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RpcContext } from '../../core'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayListing
} from '../../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from '../../../mobile-desktop-relay/mobile-relay-host-catalog'
import { OnDemandServerWorktreeRows } from '../../../mobile-desktop-relay/on-demand-server-worktree-rows'
import type * as SnapshotIds from '../../workspace-client-views/content-snapshot-id'
import { MOBILE_RELAY_HOSTS_METHODS } from './mobile-relay-hosts'

const rowHashes = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../workspace-client-views/content-snapshot-id', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotIds>()
  return {
    ...actual,
    contentSnapshotId: (serialized: string) => {
      rowHashes.count += 1
      return actual.contentSnapshotId(serialized)
    }
  }
})

const worktreesMethod = MOBILE_RELAY_HOSTS_METHODS.find(
  (entry) => entry.name === MOBILE_RELAY_HOST_WORKTREES_METHOD
)!

const WORKTREES = 7_500

const ReplySchema = z.looseObject({
  snapshotId: z.string(),
  rowsFromBase: z.array(z.unknown()).optional(),
  worktrees: z.array(z.unknown()).optional()
})

function serverRow(index: number, agentState = 'idle') {
  return {
    worktreeId: `repo-1::/srv/wt-${index}`,
    repoId: 'repo-1',
    path: `/srv/wt-${index}`,
    branch: `feature-${index}`,
    // Every third row another desktop created, so the desktop stamps it with its own view.
    ...(index % 3 === 0
      ? { creatorProvenance: { kind: 'paired-device', deviceId: 'other-desktop' } }
      : {}),
    agents: [{ id: `agent-${index}`, state: agentState }]
  }
}

function relayedServer() {
  let rows = Array.from({ length: WORKTREES }, (_, index) => serverRow(index))
  const listing: MobileDesktopRelayListing = {
    environments: [
      {
        id: 'env-1',
        name: 'Build box',
        pairingRevision: 1,
        runtimeId: 'rt-1',
        pairedDeviceId: 'this-desktop'
      }
    ],
    statusByEnvironmentId: new Map([
      [
        'env-1',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: health reads only the protocol fields.
        {
          status: {
            capabilities: [],
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION
          },
          checkedAt: 1
        } as unknown as RuntimeEnvironmentStatus
      ]
    ]),
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map()
  }
  const call = vi.fn(async () => ({
    id: 'call',
    ok: true as const,
    // Each server reply is freshly parsed, so no row keeps its object across fetches.
    result: { worktrees: JSON.parse(JSON.stringify(rows)) },
    _meta: { runtimeId: 'rt-1' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the on-demand rows read only list and call.
  const hosts = { list: () => listing, call } as unknown as MobileDesktopRelayHosts
  const catalog = new MobileRelayHostCatalog({
    hosts,
    serverRows: new OnDemandServerWorktreeRows(hosts),
    hostLabelOverrides: () => new Map(),
    // The desktop has a browser tab open in row 1, so that row is stamped as active too.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only browser tab activity is read.
    getWorkspaceSession: () => ({ browserTabsByWorktree: { 'repo-1::/srv/wt-1': [{}] } }) as never
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these context fields.
  const ctx = {
    connectionId: 'phone-1',
    clientCapabilities: [],
    mobileRelayHosts: catalog
  } as unknown as RpcContext
  const read = async (afterSnapshotId: string | null) =>
    ReplySchema.parse(
      await worktreesMethod.handler(
        MobileRelayHostWorktreesParamsSchema.parse({
          hostId: 'runtime:env-1',
          afterSnapshotId,
          acceptRowDelta: true
        }),
        ctx
      )
    )
  const changeOneRow = (index: number) => {
    rows = rows.map((row, at) => (at === index ? serverRow(index, 'working') : row))
  }
  return { read, changeOneRow, call }
}

describe('mobileRelay.hosts.worktrees row hashing', () => {
  it('hashes only the changed row when a phone re-reads after one row changed', async () => {
    const { read, changeOneRow, call } = relayedServer()
    const first = await read(null)
    expect(first.worktrees).toHaveLength(WORKTREES)
    expect(first.worktrees?.[0]).toMatchObject({ desktopOtherClient: true })
    expect(first.worktrees?.[1]).toMatchObject({ hasHostSidebarActivity: true })

    changeOneRow(42)
    rowHashes.count = 0
    const second = await read(first.snapshotId)

    expect(call).toHaveBeenCalledTimes(2)
    // One changed row plus the reply envelope, not one per worktree.
    expect(rowHashes.count).toBe(2)
    const sent = second.rowsFromBase?.filter((entry) => typeof entry !== 'number')
    expect(sent).toEqual([expect.objectContaining({ worktreeId: 'repo-1::/srv/wt-42' })])
  })

  it('still answers unchanged when nothing changed, and sends a changed stamped row', async () => {
    const { read, changeOneRow } = relayedServer()
    const first = await read(null)
    rowHashes.count = 0
    expect(await read(first.snapshotId)).toEqual({ unchanged: true, snapshotId: first.snapshotId })
    expect(rowHashes.count).toBe(1)

    // Row 3 carries the other-client stamp, so its object is rebuilt for the desktop's view.
    changeOneRow(3)
    const second = await read(first.snapshotId)
    const sent = second.rowsFromBase?.filter((entry) => typeof entry !== 'number')
    expect(sent).toEqual([
      expect.objectContaining({
        worktreeId: 'repo-1::/srv/wt-3',
        agents: [{ id: 'agent-3', state: 'working' }]
      })
    ])
  })
})
