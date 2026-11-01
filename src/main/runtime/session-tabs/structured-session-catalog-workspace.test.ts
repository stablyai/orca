import { afterEach, expect, it, vi } from 'vitest'

// Ancestors outside this fixture's owner boundaries are inert; owner methods below are real.
vi.mock('../session-graph/session-graph-reload-lifecycle.ts', () => ({
  OrcaRuntimeWithHasTerminalsForWorktree: class {}
}))
vi.mock('../orca-runtime-read-kitty-file.ts', () => ({ OrcaRuntimeWithReadKittyFile: class {} }))
vi.mock('./headless-tab-group-moves.ts', () => ({ RuntimeHeadlessTabGroups: class {} }))
vi.mock('./structured-session-account-home.ts', () => ({
  OrcaRuntimeWithStructuredSessionAccountHome: class {}
}))

import { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'
import { RuntimeWorkspaceCatalog } from '../workspaces/workspace-catalog'
import { RuntimeWorkspaceRepoScanRefresh } from '../workspaces/workspace-repo-scan-refresh'
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import { OrcaRuntimeWithPersistHeadlessTerminalTitle } from '../workspaces/workspace-file-session-targets'
import { StructuredSessionWorkspaceScope } from './structured-session-workspace-scope'
import { RuntimeResolvedWorktreeCache } from '../runtime-resolved-worktree-cache'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../rpc/methods/structured-agent-session-options-read'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { createAgentModelCatalogService } from '../../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS
} from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from '../../native-chat/agent-model-catalog/agent-model-catalog-listing-waiters'

import type { Repo } from '../../../shared/repo-types'
import type { Project } from '../../../shared/project-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RpcContext } from '../rpc/core'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentModelCatalogReadParams } from '../../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanInFlight } from '../orca-runtime-core'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { ResolvedWorktreeScanJoin } from '../workspaces/resolved-worktree-scan-join'
import { getRuntimeFolderWorkspaceInstanceId } from '../runtime-folder-workspace'

type ScopeFixture = {
  store: RuntimeStore
  resolvedWorktrees: RuntimeResolvedWorktreeCache
  projectCachedWorktrees: () => ResolvedWorktreeScanJoin
  worktreeScanCache: Map<string, RuntimeWorktreeScanCache>
  worktreeScanGenerations: Map<string, number>
  worktreeScanInFlight: Map<string, RuntimeWorktreeScanInFlight>
  resolveStructuredAgentCatalogWorkspace: StructuredSessionWorkspaceScope['resolveStructuredAgentCatalogWorkspace']
  structuredAgentSessionCatalogWorkspaceIdentity: StructuredSessionWorkspaceScope['structuredAgentSessionCatalogWorkspaceIdentity']
  resolveRuntimeFileTarget: (
    selector: string
  ) => Promise<{ worktree: ResolvedWorktree; executionHostId: string }>
  structuredAgentSessionLocationForTarget: (target: {
    worktree: ResolvedWorktree
    executionHostId: string
  }) => { wslDistro: string | null; workspaceKind: string }
  resolveFolderWorkspaceLaunchScope: () => Promise<null>
  resolveFolderWorkspaceSelector: () => null
  refreshRepoWorktreeScan: (repo: Repo) => Promise<{
    result: RuntimeWorktreeScanResult
    adminFingerprint: null
    adminFingerprintProbe: null
    scannedAt: number
  }>
  invalidateWorktreeCatalog: (repoId: string) => void
  invalidateResolvedWorktreeCache: () => void
  pruneUnregisteredWorktreeScans: () => void
  listRepoWorktreesForResolution: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
}

const accountHome = { variable: 'HOME', path: '/private-fixture/account' }
const listed = (id = 'saved') => ({
  origin: 'probe' as const,
  complete: true,
  models: [{ id, label: id, isDefault: true, efforts: [] }]
})
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function rig(agent = 'opencode') {
  const repos: Repo[] = [
    {
      id: 'r1',
      path: '/private-fixture/w1',
      displayName: 'R1',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local'
    },
    {
      id: 'r2',
      path: '/private-fixture/w2',
      displayName: 'R2',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local'
    }
  ]
  const metadata: Record<string, Partial<WorktreeMeta>> = {
    'r1::/private-fixture/w1': { instanceId: 'i1', hostId: 'local', displayName: 'W1' },
    'r2::/private-fixture/w2': { instanceId: 'i2', hostId: 'local', displayName: 'W2' }
  }
  const writes = vi.fn((target: string | { id: string }, patch: Partial<WorktreeMeta>) => {
    const id = typeof target === 'string' ? target : target.id
    return (metadata[id] = {
      ...metadata[id],
      ...patch,
      instanceId: metadata[id]?.instanceId ?? 'new-id'
    })
  })
  const projects: Project[] = []
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjects: () => projects,
    getSettings: () => ({}),
    getFolderWorkspaces: () => [],
    getAllWorktreeMeta: () => metadata,
    getWorktreeMeta: (id: string) => metadata[id],
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    setWorktreeMeta: writes
  }
  // Compose the same owner methods without creating a service, app, journal or process.
  const runtimeState = {
    store,
    resolvedWorktrees: new RuntimeResolvedWorktreeCache(),
    worktreeScanCache: new Map(),
    worktreeScanGenerations: new Map(),
    worktreeScanInFlight: new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: shipping prototypes are installed immediately below and the fixture supplies their observed dependency slice.
  const runtime = runtimeState as unknown as ScopeFixture
  for (const owner of [
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree,
    RuntimeWorkspaceSelectors,
    RuntimeWorkspaceCatalog,
    RuntimeWorkspaceRepoScanRefresh,
    OrcaRuntimeWithPersistHeadlessTerminalTitle,
    StructuredSessionWorkspaceScope
  ]) {
    for (const key of Object.getOwnPropertyNames(owner.prototype)) {
      if (key !== 'constructor') {
        Object.defineProperty(runtime, key, Object.getOwnPropertyDescriptor(owner.prototype, key)!)
      }
    }
  }
  runtime.resolveFolderWorkspaceLaunchScope = async () => null
  runtime.resolveFolderWorkspaceSelector = () => null
  let heldScan: Promise<void> | undefined
  const scan = vi.fn(async (repo: Repo) => {
    if (heldScan) {
      await heldScan
    }
    return {
      result: {
        ok: true,
        worktrees: [
          {
            path: repo.path,
            head: 'head',
            branch: 'refs/heads/main',
            isMainWorktree: true,
            isBare: false
          }
        ]
      },
      adminFingerprint: null,
      adminFingerprintProbe: null,
      scannedAt: Date.now()
    }
  })
  runtime.refreshRepoWorktreeScan = scan
  const account = vi.fn(async () => accountHome)
  const resolveInvocation = vi.fn(async () => ({ identity: 'launch', run: listing }))
  let heldListing: Promise<ReturnType<typeof listed>> | undefined
  const listing = vi.fn(async () => (heldListing ? heldListing : listed('new')))
  const defaultCheck = vi.fn(async () => false)
  const probe = Object.assign(listing, { resolve: resolveInvocation })
  const catalogStore = new AgentModelCatalogStore()
  const base = agentModelCatalogFingerprint({
    agent,
    accountHome,
    wslDistro: null,
    ...(agent === 'opencode' ? { folder: '/private-fixture/w2' } : {})
  })
  const fingerprint =
    agent === 'claude'
      ? agentModelCatalogScopeFingerprint(base, '/private-fixture/w2', 'launch')
      : base
  catalogStore.recordSuccess(fingerprint, agent, listed(), 'discovery')
  const persist = vi.fn()
  const catalog = createAgentModelCatalogService({
    store: catalogStore,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: account,
    probes: { [agent]: probe },
    listsInChatFolder: new Set(['opencode']),
    workspaceMayOverrideDefaultModel: defaultCheck
  })
  cleanups.push(catalog.stop)
  const demands: Promise<void>[] = []
  let request: AgentModelCatalogReadParams | undefined
  const exposed = {
    ...catalog,
    demand: (params: AgentModelCatalogReadParams) => {
      request = params
      const promise = catalog.demand(params)
      demands.push(promise)
      return promise
    },
    read: (params: AgentModelCatalogReadParams) => {
      request = params
      return catalog.read(params)
    }
  }
  const hostSlice = {
    deps: {
      store: { getConversation: () => undefined, getRecord: () => undefined },
      modelCatalog: exposed
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC accesses only the installed catalog and record lookup dependencies supplied here.
  const host = hostSlice as unknown as StructuredAgentSessionHost
  setStructuredAgentSessionHost(host)
  const method = STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS.find(
    (row) => row.name === 'agentSession.modelCatalog'
  )!
  const contextSlice = { runtime }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this RPC reads only the composed runtime slice and has no transport dependencies.
  const context = contextSlice as unknown as RpcContext
  const rpc = async (params = {}) =>
    method.handler(method.params!.parse({ agent, worktree: 'name:W2', ...params }), context)
  const current = () => rpc({ savedOnly: true })
  const counts = () => [
    scan.mock.calls.length,
    writes.mock.calls.length,
    account.mock.calls.length,
    resolveInvocation.mock.calls.length,
    listing.mock.calls.length,
    defaultCheck.mock.calls.length,
    persist.mock.calls.length
  ]
  return {
    runtime,
    store,
    repos,
    projects,
    metadata,
    catalog,
    catalogStore,
    fingerprint,
    writes,
    scan,
    account,
    resolveInvocation,
    listing,
    defaultCheck,
    persist,
    rpc,
    current,
    counts,
    demands,
    get request() {
      return request
    },
    setScan: (p?: Promise<void>) => (heldScan = p),
    setListing: (p: Promise<ReturnType<typeof listed>>) => (heldListing = p)
  }
}

it('keeps the selected workspace through unrelated invalidation, fences genuine changes, and never advances expired resolution', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const h = rig()
  await h.catalogStore.attachPersistence({
    load: async () => [],
    save: h.persist,
    flush: async () => {}
  })
  delete h.metadata['r2::/private-fixture/w2'].instanceId
  const scans = Promise.withResolvers<void>()
  h.setScan(scans.promise)
  const initialCounts = h.counts()
  expect(await h.current()).toEqual({ origin: 'unknown' })
  expect(h.counts()).toEqual(initialCounts)
  const cold = await h.rpc()
  expect(cold).toMatchObject({ origin: 'unknown' })
  await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(2))
  scans.resolve()
  await Promise.all(h.demands)
  const prepared = await h.current()
  expect(prepared).toMatchObject({ models: [{ id: 'saved', isDefault: true }] })
  const savedCounts = h.counts()
  expect(await h.current()).toEqual(prepared)
  expect(h.counts()).toEqual(savedCounts)

  vi.setSystemTime(Date.now() + AGENT_MODEL_CATALOG_FRESH_MS + 1)
  const pending = Promise.withResolvers<ReturnType<typeof listed>>()
  h.setListing(pending.promise)
  await h.rpc()
  await vi.waitFor(() => expect(h.listing).toHaveBeenCalledTimes(1))
  h.metadata['r1::/private-fixture/w1'].displayName = 'W1 renamed'
  delete h.metadata['r1::/private-fixture/w1'].instanceId
  h.runtime.invalidateWorktreeCatalog('r1')
  h.catalog.retireContext('r1::/private-fixture/w1')
  const nonmatchingCounts = h.counts()
  expect(h.runtime.resolvedWorktrees.peek()).toBeNull()
  expect(await h.current()).toMatchObject({ models: [{ id: 'saved', isDefault: true }] })
  expect(h.counts()).toEqual(nonmatchingCounts)
  pending.resolve(listed('unrelated-completed'))
  await Promise.all(h.demands)
  expect(h.catalogStore.get(h.fingerprint)?.models[0].id).toBe('unrelated-completed')

  // Hold a new operation's existing default and listing continuations, then create ambiguity.
  vi.setSystemTime(Date.now() + AGENT_MODEL_CATALOG_FRESH_MS + 1)
  const stale = Promise.withResolvers<ReturnType<typeof listed>>()
  const defaults = Promise.withResolvers<boolean>()
  h.setListing(stale.promise)
  h.defaultCheck.mockReturnValueOnce(defaults.promise)
  await h.rpc()
  await vi.waitFor(() => expect(h.listing).toHaveBeenCalledTimes(2))
  const preserved = JSON.stringify(h.catalogStore.get(h.fingerprint))
  const failure = h.catalogStore.failureDetail(h.fingerprint)
  const savedWrites = h.persist.mock.calls.length
  h.metadata['r1::/private-fixture/w1'].displayName = 'W2'
  h.runtime.invalidateWorktreeCatalog('r1')
  h.catalog.retireContext('r1::/private-fixture/w1')
  expect(await h.current()).toEqual({ origin: 'unknown' })
  defaults.resolve(false)
  stale.resolve(listed('must-not-ingest'))
  await Promise.all(h.demands)
  expect(JSON.stringify(h.catalogStore.get(h.fingerprint))).toBe(preserved)
  expect(h.catalogStore.failureDetail(h.fingerprint)).toBe(failure)
  expect(h.persist).toHaveBeenCalledTimes(savedWrites)

  const expired = rig('claude')
  const delayed = Promise.withResolvers<void>()
  const realResolver = expired.runtime.resolveStructuredAgentCatalogWorkspace.bind(expired.runtime)
  const completedScope = vi.fn(async (selector: string) => {
    const resolved = await realResolver(selector)
    await delayed.promise
    return resolved
  })
  expired.runtime.resolveStructuredAgentCatalogWorkspace = completedScope
  await expired.rpc()
  await vi.waitFor(() => expect(completedScope).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(AGENT_MODEL_CATALOG_PICKER_WAIT_MS + 1)
  await Promise.all(expired.demands)
  delayed.resolve()
  await vi.runAllTimersAsync()
  expect(expired.account).not.toHaveBeenCalled()
  expect(expired.resolveInvocation).not.toHaveBeenCalled()
  expect(expired.defaultCheck).not.toHaveBeenCalled()
  expect(expired.listing).not.toHaveBeenCalled()

  // Restore one match, then independently change the actual selected host, path, and distro route.
  h.metadata['r1::/private-fixture/w1'].displayName = 'W1'
  for (const change of ['path', 'host', 'distro']) {
    const routed = rig()
    await routed.rpc()
    await Promise.all(routed.demands)
    vi.setSystemTime(Date.now() + AGENT_MODEL_CATALOG_FRESH_MS + 1)
    const late = Promise.withResolvers<ReturnType<typeof listed>>()
    routed.setListing(late.promise)
    await routed.rpc()
    await vi.waitFor(() => expect(routed.listing).toHaveBeenCalledOnce())
    const oldEntry = JSON.stringify(routed.catalogStore.get(routed.fingerprint))
    if (change === 'path') {
      const listing = routed.runtime.worktreeScanCache.get('r2\0local')?.listing
      if (!listing) {
        throw new Error('selected workspace was not cached')
      }
      listing.worktrees[0].path += '/moved'
    }
    if (change === 'host') {
      routed.repos[1].executionHostId = 'ssh:other'
    }
    if (change === 'distro') {
      // An explicit project preference supplies the real location owner with a distro.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      cleanups.push(() => Object.defineProperty(process, 'platform', platform))
      routed.projects.push({
        id: 'project',
        displayName: 'Project',
        badgeColor: '',
        sourceRepoIds: ['r2'],
        createdAt: 0,
        updatedAt: 0,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    }
    routed.runtime.invalidateResolvedWorktreeCache()
    if (change === 'distro') {
      const target = await routed.runtime.resolveRuntimeFileTarget('name:W2')
      expect(routed.runtime.structuredAgentSessionLocationForTarget(target).wslDistro).toBe(
        'Ubuntu'
      )
    }
    routed.runtime.invalidateResolvedWorktreeCache()
    routed.catalog.retireContext('r2::/private-fixture/w2')
    expect(await routed.current()).toEqual({ origin: 'unknown' })
    late.reject(new AgentModelCatalogUnavailableError({ reason: 'notSignedIn', account: 'system' }))
    await Promise.all(routed.demands)
    expect(JSON.stringify(routed.catalogStore.get(routed.fingerprint))).toBe(oldEntry)
    expect(routed.catalogStore.failureDetail(routed.fingerprint)).toBeNull()
    vi.restoreAllMocks()
  }
})

it('releases removed scans and makes old owners and joiners use a re-registered repo', async () => {
  const h = rig()
  const pending = Promise.withResolvers<void>()
  h.setScan(pending.promise)
  const first = h.runtime.listRepoWorktreesForResolution(h.repos[0])
  const joined = h.runtime.listRepoWorktreesForResolution(h.repos[0])
  const old = h.repos.shift()!
  h.runtime.pruneUnregisteredWorktreeScans()
  expect(h.runtime.worktreeScanInFlight.size).toBe(0)
  expect(h.runtime.worktreeScanGenerations.size).toBe(0)
  expect(h.runtime.worktreeScanCache.size).toBe(0)
  h.repos.unshift({ ...old, path: '/replacement' })
  h.setScan()
  pending.resolve()
  for (const result of await Promise.all([first, joined])) {
    expect(result.worktrees.map((row) => row.path)).toEqual(['/replacement'])
  }
  expect(h.scan).toHaveBeenCalledTimes(2)
  expect(h.runtime.worktreeScanCache.get('r1\0local')?.result.worktrees[0].path).toBe(
    '/replacement'
  )
  h.repos.shift()
  h.runtime.pruneUnregisteredWorktreeScans()
  expect(h.runtime.worktreeScanCache.size).toBe(0)
  expect(h.runtime.worktreeScanInFlight.size).toBe(0)
})

it('shares one failed SSH stored-row refresh at N and 10N callers without caching failure', async () => {
  for (const callers of [5, 50]) {
    const h = rig()
    const repo = h.repos[0]
    repo.executionHostId = 'ssh:fixture'
    h.metadata['r1::/private-fixture/w1'].hostId = 'ssh:fixture'
    Object.defineProperty(
      h.runtime,
      'refreshRepoWorktreeScan',
      Object.getOwnPropertyDescriptor(
        RuntimeWorkspaceRepoScanRefresh.prototype,
        'refreshRepoWorktreeScan'
      )!
    )
    const refresh = vi.spyOn(h.runtime, 'refreshRepoWorktreeScan')
    const results = await Promise.all(
      Array.from({ length: callers }, () => h.runtime.listRepoWorktreesForResolution(repo))
    )
    expect(results).toEqual(
      Array.from({ length: callers }, () => ({
        ok: false,
        worktrees: [{ path: repo.path, head: '', branch: '', isMainWorktree: true, isBare: false }]
      }))
    )
    expect.soft(refresh, `${callers} concurrent callers`).toHaveBeenCalledTimes(1)
    expect(h.runtime.worktreeScanCache.size).toBe(0)
    expect(h.runtime.worktreeScanInFlight.size).toBe(0)
    await h.runtime.listRepoWorktreesForResolution(repo)
    expect.soft(refresh, `${callers} callers then a new request`).toHaveBeenCalledTimes(2)
  }
})

it('catalog-scale corpus measures held RPC qualification without optional work or metadata writes', async () => {
  for (const repoCount of [20, 200]) {
    const h = rig()
    h.repos.splice(0)
    for (const key of Object.keys(h.metadata)) {
      delete h.metadata[key]
    }
    let gitRows = 0
    for (let index = 0; index < repoCount; index++) {
      const folder = index % 10 === 0
      const repo: Repo = {
        id: `r${index + 1}`,
        path: `/private-fixture/w${index + 1}`,
        displayName: `Repository ${index}`,
        kind: folder ? 'folder' : 'git',
        badgeColor: '',
        addedAt: 0,
        executionHostId: 'local'
      }
      h.repos.push(repo)
      const worktrees = Array.from({ length: 4 }, (_, row) => ({
        path: row === 0 ? repo.path : `${repo.path}/checkouts/feature-${row}`,
        head: `commit-${index}-${row}`,
        branch: `refs/heads/feature-${row}`,
        isMainWorktree: row === 0,
        isBare: false
      }))
      worktrees.forEach((row, number) => {
        const id = folder
          ? number === 0
            ? `${repo.id}::${repo.path}`
            : getRuntimeFolderWorkspaceInstanceId(repo, `folder-${number}`)
          : `${repo.id}::${row.path}`
        h.metadata[id] = {
          instanceId: `instance-${index}-${number}`,
          hostId: 'local',
          displayName: index === 1 && number === 0 ? 'W2' : `Workspace ${index}-${number}`
        }
      })
      if (!folder) {
        gitRows += worktrees.length
        h.runtime.worktreeScanCache.set(`${repo.id}\0local`, {
          generation: 0,
          runtimeKey: '',
          result: { ok: true, worktrees },
          listing: { ok: true, worktrees },
          expiresAt: Date.now() + 60_000,
          adminFingerprint: null,
          scannedAt: Date.now()
        })
      }
    }
    const models = Array.from({ length: repoCount * 4 }, (_, index) => ({
      id: `provider/model-${index}`,
      label: `Provider model ${index}`,
      isDefault: index === 0,
      efforts: [{ value: 'high', label: 'High' }]
    }))
    h.catalogStore.recordSuccess(
      h.fingerprint,
      'opencode',
      { origin: 'probe', models },
      'discovery'
    )
    await h.catalog.demand({
      agent: 'opencode',
      workspace: {
        selector: 'name:W2',
        identity: () => h.runtime.structuredAgentSessionCatalogWorkspaceIdentity('name:W2'),
        resolve: async () => ({
          identity: h.runtime.structuredAgentSessionCatalogWorkspaceIdentity('name:W2'),
          path: '/private-fixture/w2'
        })
      }
    })
    let repoVisits = 0
    let metadataVisits = 0
    let metadataKeys = 0
    const repos = h.repos.slice()
    repos.forEach((repo, index) => {
      Object.defineProperty(repos, index, {
        get() {
          repoVisits++
          return repo
        }
      })
    })
    const metadata = new Proxy(h.metadata, {
      get(target, key) {
        if (typeof key === 'string') {
          metadataVisits++
          return target[key]
        }
        return undefined
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target)
        metadataKeys += keys.length
        return keys
      }
    })
    vi.spyOn(h.store, 'getRepos').mockImplementation(() => repos)
    vi.spyOn(h.store, 'getAllWorktreeMeta').mockImplementation(() => metadata)
    const projection = vi.spyOn(h.runtime, 'projectCachedWorktrees')
    const before = h.counts()
    const start = performance.now()
    let answer: unknown
    for (let read = 0; read < 4; read++) {
      answer = await h.current()
    }
    const elapsedMs = performance.now() - start
    expect(answer).toMatchObject({
      models: expect.arrayContaining([{ ...models[0], isDefault: true }])
    })
    expect(h.counts()).toEqual(before)
    expect(projection).toHaveBeenCalledTimes(4)
    expect(repoVisits).toBeGreaterThanOrEqual(repoCount)
    expect(repoVisits).toBeLessThanOrEqual(4 * (repoCount ** 2 + 10 * repoCount))
    expect(metadataVisits).toBeLessThanOrEqual(4 * repoCount * 4)
    expect(metadataKeys).toBeGreaterThan(0)
    expect(metadataKeys).toBeLessThanOrEqual(4 * (repoCount / 10) * (repoCount * 4))
    expect(
      projection.mock.results.every(
        (result) => result.type === 'return' && result.value.worktrees.length === repoCount * 4
      )
    ).toBe(true)
    process.stdout.write(
      `CATALOG_CORPUS ${JSON.stringify({
        repoCount,
        folderRepos: repoCount / 10,
        gitRows,
        workspaceRows: repoCount * 4,
        modelRows: models.length,
        reads: 4,
        projections: projection.mock.calls.length,
        repoVisits,
        metadataVisits,
        metadataKeys,
        responseBytes: Buffer.byteLength(JSON.stringify(answer)),
        elapsedMs,
        optionalWork: h.counts().map((value, index) => value - before[index])
      })}\n`
    )
    h.catalog.stop()
    vi.restoreAllMocks()
  }
})
