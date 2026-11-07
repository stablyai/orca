import { afterEach, expect, it, vi } from 'vitest'

// Ancestors outside this fixture's owner boundaries are inert; owner methods below are real.
vi.mock('../session-graph/session-graph-reload-lifecycle.ts', () => ({
  OrcaRuntimeWithHasTerminalsForWorktree: class {}
}))
vi.mock('../files/paths/orca-runtime-read-kitty-file.ts', () => ({
  OrcaRuntimeWithReadKittyFile: class {}
}))
vi.mock('./headless-tab-group-moves.ts', () => ({ RuntimeHeadlessTabGroups: class {} }))
vi.mock('./structured-session-account-home.ts', () => ({
  OrcaRuntimeWithStructuredSessionAccountHome: class {}
}))

import { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'
import { RuntimeWorkspaceCatalog } from '../workspaces/catalog/workspace-catalog'
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import { RuntimeWorkspaceFileTargets } from '../workspaces/workspace-file-session-targets'
import { StructuredSessionWorkspaceScope } from './structured-session-workspace-scope'
import { RuntimeResolvedWorktreeCache } from '../workspaces/catalog/runtime-resolved-worktree-cache'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../rpc/methods/structured-sessions/catalog/structured-agent-session-options-read'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogReadParams } from '../../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { RpcContext } from '../rpc/core'

const repo = (id: string, path: string): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

/** A fleet of `worktrees` worktrees across a fixed set of repos, with warm scan caches, so any
 *  fleet-wide projection or selector match would have every row to walk. */
function rig(worktrees: number) {
  const repos = [repo('r1', '/fleet/r1'), repo('r2', '/fleet/r2'), repo('r3', '/fleet/r3')]
  const metadata: Record<string, Partial<WorktreeMeta>> = {}
  const scans = new Map<string, unknown>()
  for (const owner of repos) {
    const rows = Array.from({ length: worktrees / repos.length }, (_, index) => ({
      path: index === 0 ? owner.path : `${owner.path}-wt-${index}`,
      head: 'head',
      branch: `refs/heads/b${index}`,
      isMainWorktree: index === 0,
      isBare: false
    }))
    for (const row of rows) {
      metadata[`${owner.id}::${row.path}`] = { instanceId: row.path, hostId: 'local' }
    }
    scans.set(`${owner.id}\0local`, { result: { ok: true, worktrees: rows }, scannedAt: 0 })
  }
  const store = {
    getRepos: vi.fn(() => repos),
    getRepo: (id: string) => repos.find((candidate) => candidate.id === id),
    getSettings: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getAllWorktreeMeta: vi.fn(() => metadata),
    getWorktreeMeta: vi.fn((id: string) => metadata[id]),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({})
  }
  // Compose the shipping owner methods without creating a service, app, journal or process.
  const runtime: Record<string, unknown> = {
    store,
    resolvedWorktrees: new RuntimeResolvedWorktreeCache(),
    worktreeScanCache: scans,
    worktreeScanGenerations: new Map(),
    worktreeScanInFlight: new Map()
  }
  for (const owner of [
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree,
    RuntimeWorkspaceSelectors,
    RuntimeWorkspaceCatalog,
    RuntimeWorkspaceFileTargets,
    StructuredSessionWorkspaceScope
  ]) {
    for (const key of Object.getOwnPropertyNames(owner.prototype)) {
      if (key !== 'constructor') {
        Object.defineProperty(runtime, key, Object.getOwnPropertyDescriptor(owner.prototype, key)!)
      }
    }
  }
  runtime.requireStore = () => store
  runtime.resolveFolderWorkspaceSelector = () => null
  // Every fleet-wide path the old identity walked; the picker must reach none of them.
  const fleet = {
    listResolvedWorktrees: vi.fn(),
    matchWorktreeSelector: vi.fn(),
    joinResolvedWorktreeScans: vi.fn()
  }
  Object.assign(runtime, fleet)
  const listing = vi.fn(async () => ({
    origin: 'probe' as const,
    complete: true,
    models: [{ id: 'm', label: 'm', isDefault: true, efforts: [] }]
  }))
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' }),
    probes: {
      codex: Object.assign(listing, {
        resolve: async () => ({ identity: 'codex', run: listing })
      })
    }
  })
  const requests: AgentModelCatalogReadParams[] = []
  runtime.structuredAgentModelCatalog = async () => ({
    ...catalog,
    read: (params: AgentModelCatalogReadParams) => {
      requests.push(params)
      return catalog.read(params)
    }
  })
  const method = STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS.find(
    (row) => row.name === 'agentSession.modelCatalog'
  )!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this RPC reads only the composed runtime slice and has no transport dependencies.
  const context = { runtime } as unknown as RpcContext
  const open = (worktree: string) =>
    method.handler(
      method.params!.parse({ agent: 'codex', worktree, waitForListing: true }),
      context
    )
  const work = () => [store.getRepos.mock.calls.length, store.getWorktreeMeta.mock.calls.length]
  return { catalog, store, fleet, requests, open, work }
}

it.each([
  ['id:r2::/fleet/r2-wt-1', '/fleet/r2-wt-1'],
  ['r2::/fleet/r2-wt-1', '/fleet/r2-wt-1'],
  ['path:/fleet/r2', '/fleet/r2']
])(
  'opening the picker for %s reads only that workspace, at N and 10N worktrees',
  async (selector, path) => {
    // One picker open needs one folder; nothing it does may depend on how many worktrees exist.
    const runs: number[][] = []
    for (const worktrees of [30, 300]) {
      const h = rig(worktrees)
      try {
        expect(await h.open(selector)).toMatchObject({ origin: 'probe', models: [{ id: 'm' }] })
        expect(h.requests.at(-1)?.workspacePath).toBe(path)
        expect(h.store.getAllWorktreeMeta).not.toHaveBeenCalled()
        expect(h.fleet.listResolvedWorktrees).not.toHaveBeenCalled()
        expect(h.fleet.matchWorktreeSelector).not.toHaveBeenCalled()
        expect(h.fleet.joinResolvedWorktreeScans).not.toHaveBeenCalled()
        runs.push(h.work())
      } finally {
        h.catalog.stop()
      }
    }
    expect(runs[1]).toEqual(runs[0])
  }
)

it('names no workspace for a path two hosts share, without walking worktrees', async () => {
  const h = rig(30)
  try {
    h.store.getRepos.mockReturnValue([
      ...h.store.getRepos(),
      { ...repo('r2', '/fleet/r2'), executionHostId: 'ssh:remote' }
    ])
    await h.open('path:/fleet/r2')
    expect(h.requests.at(-1)?.workspacePath).toBeNull()
    expect(h.fleet.matchWorktreeSelector).not.toHaveBeenCalled()
  } finally {
    h.catalog.stop()
  }
})
