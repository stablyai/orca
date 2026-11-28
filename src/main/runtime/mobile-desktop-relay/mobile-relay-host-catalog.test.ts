import { describe, expect, it } from 'vitest'
import { projectPluginWorkspaceContext } from '../../plugins/workers/host-api/plugin-workspace-projection'
import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { MobileRelayServerWorktreeRow } from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { MobileDesktopRelayListing } from './mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog, type ServerWorktreeRows } from './mobile-relay-host-catalog'

const ENVIRONMENT_ID = 'env-1'
const HOST_ID = `runtime:${ENVIRONMENT_ID}` as const
const worktreeId = 'repo-1::/home/me/code/orca'

function catalog(
  rows: readonly MobileRelayServerWorktreeRow[],
  environmentId: string = ENVIRONMENT_ID
): MobileRelayHostCatalog {
  const serverRows: ServerWorktreeRows = {
    sync: () => undefined,
    refresh: async () => undefined,
    rows: () => rows
  }
  const listing: MobileDesktopRelayListing = {
    environments: [
      { id: environmentId, name: 'paired-server', pairingRevision: 1, runtimeId: 'runtime-1' }
    ],
    statusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map()
  }
  return new MobileRelayHostCatalog({
    hosts: {
      list: () => listing,
      resolve: async () => null,
      call: async () => ({ id: 'call-1', ok: true, result: null, _meta: { runtimeId: 'r-1' } }),
      hostsBrowserPage: () => false,
      onEnvironmentRetired: () => () => undefined,
      onStatusChanged: () => () => undefined,
      watchChanges: () => ({ close: () => undefined, current: () => false })
    },
    serverRows,
    hostLabelOverrides: () => new Map(),
    getWorkspaceSession: () => null
  })
}

function row(overrides: Record<string, unknown> = {}): MobileRelayServerWorktreeRow {
  return {
    worktreeId,
    repoId: 'repo-1',
    kind: 'worktree',
    workspaceKind: 'worktree',
    path: '/home/me/code/orca',
    branch: 'main',
    displayName: 'orca',
    isArchived: false,
    isPinned: false,
    ...overrides,
    hostId: HOST_ID
  }
}

describe('a paired-server workspace in the plugin host context', () => {
  it('lists a path-free workspaceId that names its server', async () => {
    const context = await catalog([row({ worktreeInstanceId: 'instance-1' })]).workspaceContext(
      HOST_ID,
      worktreeId
    )

    // What a worker's `workspace.readContext` and `workspace.changed` carry.
    expect(projectPluginWorkspaceContext(context, [])).toEqual({
      workspaceId: 'identity:wt2:runtime%3Aenv-1:instance-1',
      branch: 'main',
      displayName: 'orca',
      terminals: []
    })
  })

  it('keeps two servers apart when they hold the same repo and path', async () => {
    const first = await catalog([row({ worktreeInstanceId: 'instance-1' })]).workspaceContext(
      HOST_ID,
      worktreeId
    )
    const second = await catalog(
      [row({ worktreeInstanceId: 'instance-2' })],
      'env-2'
    ).workspaceContext('runtime:env-2', worktreeId)

    // Two servers' copies share the raw `repoId::path`, so only the identity can tell them apart.
    expect(first?.worktreeId).toBe(second?.worktreeId)
    const firstListed = projectPluginWorkspaceContext(first, [])
    const secondListed = projectPluginWorkspaceContext(second, [])
    if (!firstListed || !secondListed) {
      throw new Error('both servers must project the workspace')
    }
    expect(firstListed.workspaceId).not.toBe(secondListed.workspaceId)
  })

  it('still carries a workspaceId for a row the server does not instance-stamp', async () => {
    const context = await catalog([row({ displayName: '  ' })]).workspaceContext(
      HOST_ID,
      worktreeId
    )

    // Falls back to the raw id, as before, rather than yielding no id at all.
    expect(projectPluginWorkspaceContext(context, [])).toEqual({
      workspaceId: worktreeId,
      branch: 'main',
      displayName: '/home/me/code/orca',
      terminals: []
    })
  })
})
