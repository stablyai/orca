import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../shared/endpoint-catalog-adoption'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { buildProjectGroupingIndex } from '../../../shared/project-section-grouping'
import {
  editProjectFilter,
  projectFilterSelection
} from '../../../shared/project-repo-filter-selection'
import { projectRepoFilterMatcher } from '../../../shared/project-grouping'
import { buildMobileProjectSectionCatalog } from '../../../shared/mobile-project-sections-contract'
import { ProjectSectionCatalogSchema } from '../../../shared/project-section-catalog-schema'
import { publishMobileProjectSections } from '../../runtime/mobile-project-sections-snapshot'
import { MOBILE_PROJECT_SECTIONS_METHODS } from '../../runtime/rpc/methods/mobile-project-sections'
import { getDefaultPersistedState } from '../../../shared/constants'
import { writeDataFile } from '../persistence-test-harness'
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, readDataFile, testState } from '../persistence-test-harness'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../../runtime/rpc/methods/runtime-client-capabilities'
import { RuntimeClientSettingsController } from '../../runtime/runtime-client-settings'
import { parseRuntimeClientCapabilities } from '../../runtime/rpc/runtime-client-capabilities'
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITIES,
  mobileRuntimeClientCapabilityUpdateParams
} from '../../../../mobile/src/transport/mobile-runtime-client-capabilities'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/web-runtime-client-capabilities'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { registerUIHandlers } from '../../ipc/ui'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(name, fn),
    on: () => {},
    removeAllListeners: () => {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-grouping-peers-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('roundtrips native exact Workspace/Agents and the real capability-update/raw-phone RPC paths through disk', async () => {
  const store = createStore()
  registerUIHandlers(store)
  const native = (patch: unknown) => electron.handlers.get('ui:set')!({}, patch)
  const Q = 'runtime:server\0same'
  const runtime = {
    getRuntimeId: () => 'desktop',
    getUIState: () => store.getUI(),
    updateUIState: (patch: Parameters<typeof store.updateUI>[0]) => {
      store.updateUI(patch)
      return store.getUI()
    }
  } satisfies Pick<OrcaRuntimeService, 'getRuntimeId' | 'getUIState' | 'updateUIState'>
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked consumed runtime port above; real selected non-orchestration RPCs need no other service members. This fixture is not the full service.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: [...CLIENT_UI_METHODS, ...RUNTIME_CLIENT_CAPABILITY_METHODS]
  })
  let installed: readonly string[] = []
  const update = await dispatcher.dispatch(
    {
      id: 'install',
      authToken: '',
      method: 'runtime.clientCapabilities.update',
      params: mobileRuntimeClientCapabilityUpdateParams()
    },
    {
      clientKind: 'mobile',
      updateClientCapabilities: (caps) => {
        installed = parseRuntimeClientCapabilities(caps)
      }
    }
  )
  expect(update).toMatchObject({ ok: true, result: mobileRuntimeClientCapabilityUpdateParams() })
  // The complete producers plus the existing relay addition fit the shipped parser's bound.
  expect(
    parseRuntimeClientCapabilities([
      ...MOBILE_RUNTIME_CLIENT_CAPABILITIES,
      'mobile.browser-host.v1'
    ])
  ).toHaveLength(MOBILE_RUNTIME_CLIENT_CAPABILITIES.length + 1)
  expect(parseRuntimeClientCapabilities([...WEB_RUNTIME_CLIENT_CAPABILITIES])).toHaveLength(
    WEB_RUNTIME_CLIENT_CAPABILITIES.length
  )
  for (const initial of [
    ['same', Q],
    ['same', 'local\0same', Q]
  ]) {
    native({ filterRepoIds: initial, agentsFilterRepoIds: initial })
    native({ filterRepoIds: [Q, 'offline'], agentsFilterRepoIds: [Q, 'offline'] })
    expect(store.getUI()).toMatchObject({
      filterRepoIds: [Q, 'offline'],
      agentsFilterRepoIds: [Q, 'offline']
    })
    native({ filterRepoIds: initial })
    const exact = await dispatcher.dispatch(
      {
        id: 'exact',
        authToken: '',
        method: 'ui.set',
        params: {
          filterRepoIds: [Q, 'offline'],
          filterRepoIdsMode: 'exact',
          agentsFilterRepoIds: []
        }
      },
      { clientKind: 'mobile', clientCapabilities: installed }
    )
    expect(exact).toMatchObject({ ok: true })
    expect(store.getUI()).toMatchObject({
      filterRepoIds: [Q, 'offline'],
      agentsFilterRepoIds: [Q, 'offline']
    })
    native({ filterRepoIds: initial })
    const raw = await dispatcher.dispatch(
      {
        id: 'old',
        authToken: '',
        method: 'ui.set',
        params: { filterRepoIds: initial.filter((id) => id !== 'same').concat('offline') }
      },
      { clientKind: 'mobile' }
    )
    expect(raw).toMatchObject({ ok: true })
    expect(store.getUI().filterRepoIds).toEqual(['offline'])
    store.flush()
    expect(readDataFile()).toHaveProperty('ui.filterRepoIds', ['offline'])
  }
  native({ filterRepoIds: ['same', Q], agentsFilterRepoIds: ['same', Q] })
  native({ filterRepoIds: [Q], agentsFilterRepoIds: [Q] })
  store.flush()
  await closeTestStores()
  expect(createStore().getUI()).toMatchObject({ filterRepoIds: [Q], agentsFilterRepoIds: [Q] })
  expect(readDataFile()).toHaveProperty('ui.filterRepoIds', [Q])
})

it('adapts real remote Task full-array edits against the current canonical owner before async settlement', async () => {
  const store = createStore()
  const Q = 'runtime:server\0same'
  store.updateSettings({ defaultRepoSelection: [Q, 'offline\0unseen', 'other'] })
  const controller = new RuntimeClientSettingsController(store)
  const runtime = {
    getRuntimeId: () => 'desktop',
    getClientSettings: () => controller.get(),
    updateClientSettings: (patch: Parameters<typeof controller.update>[0]) =>
      controller.update(patch)
  } satisfies Pick<
    OrcaRuntimeService,
    'getRuntimeId' | 'getClientSettings' | 'updateClientSettings'
  >
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked consumed runtime port above; real selected non-orchestration RPCs need no other service members. This fixture is not the full service.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: CLIENT_UI_METHODS
  })
  const read = await dispatcher.dispatch({ id: 'read', authToken: '', method: 'settings.get' })
  expect(read).toMatchObject({
    ok: true,
    result: { settings: { defaultRepoSelection: ['same', 'unseen', 'other'] } }
  })
  const edit = await dispatcher.dispatch({
    id: 'edit',
    authToken: '',
    method: 'settings.update',
    params: { defaultRepoSelection: ['same', 'unseen', 'new'] }
  })
  expect(edit).toMatchObject({
    ok: true,
    result: { settings: { defaultRepoSelection: ['same', 'unseen', 'new'] } }
  })
  expect(store.getSettings().defaultRepoSelection).toEqual([Q, 'offline\0unseen', 'new'])
  // A stale raw mirror must preserve the latest local refinement, not its prior read's source.
  store.updateSettings({ defaultRepoSelection: ['runtime:new\0same', 'new'] })
  await dispatcher.dispatch({
    id: 'stale',
    authToken: '',
    method: 'settings.update',
    params: { defaultRepoSelection: ['same', 'new', 'other'] }
  })
  expect(store.getSettings().defaultRepoSelection).toEqual(['runtime:new\0same', 'new', 'other'])
  await dispatcher.dispatch({
    id: 'unrelated',
    authToken: '',
    method: 'settings.update',
    params: { machineName: 'Desk' }
  })
  expect(store.getSettings().defaultRepoSelection).toEqual(['runtime:new\0same', 'new', 'other'])
  store.flush()
  await closeTestStores()
  const loaded = createStore()
  expect(loaded.getSettings().defaultRepoSelection).toEqual(['runtime:new\0same', 'new', 'other'])
  let currentOwner = loaded
  const cases: [Parameters<RuntimeClientSettingsController['update']>[0], string[] | null][] = [
    [{ defaultRepoSelection: ['new'] }, ['new']],
    [{ defaultRepoSelection: ['same', 'new'] }, ['same', 'new']],
    [{ machineName: 'After reload' }, ['same', 'new']],
    [{ defaultRepoSelection: [] }, []],
    [{ defaultRepoSelection: null }, null]
  ]
  for (const [patch, canonical] of cases) {
    const remote = new RuntimeClientSettingsController(currentOwner)
    await remote.update(patch)
    expect(currentOwner.getSettings().defaultRepoSelection).toEqual(canonical)
    expect(remote.get().defaultRepoSelection).toEqual(canonical)
    currentOwner.flush()
    expect(readDataFile()).toHaveProperty('settings.defaultRepoSelection', canonical)
    await closeTestStores()
    currentOwner = createStore()
    expect(currentOwner.getSettings().defaultRepoSelection).toEqual(canonical)
  }
})

it('selects request meaning atomically before a single current-owner mutation, independently of socket lists', async () => {
  const store = createStore()
  const Q = 'runtime:server\0same'
  const runtime = {
    getRuntimeId: () => 'desktop',
    getUIState: () => store.getUI(),
    updateUIState: vi.fn((patch: Parameters<typeof store.updateUI>[0]) => {
      store.updateUI(patch)
      return store.getUI()
    })
  } satisfies Pick<OrcaRuntimeService, 'getRuntimeId' | 'getUIState' | 'updateUIState'>
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked consumed runtime port above; real selected non-orchestration RPCs need no other service members. This fixture is not the full service.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: CLIENT_UI_METHODS
  })
  const send = (params: unknown, clientCapabilities: readonly string[] = []) =>
    dispatcher.dispatch(
      { id: 'edit', authToken: '', method: 'ui.set', params },
      { clientKind: 'mobile', clientCapabilities }
    )
  for (const caps of [[], ['unrelated'], ['ui.project-repo-filter-exact.v1']]) {
    store.updateUI({ filterRepoIds: ['same', Q], sortBy: 'name' })
    const before = runtime.updateUIState.mock.calls.length
    for (const params of [
      { filterRepoIdsMode: 'legacy', filterRepoIds: [], sortBy: 'smart' },
      { filterRepoIdsMode: 'exact', sortBy: 'smart' },
      { filterRepoIdsMode: 'exact', filterRepoIds: null, sortBy: 'smart' },
      { filterRepoIdsMode: 'exact', filterRepoIds: [42], sortBy: 'smart' }
    ]) {
      expect(await send(params, caps)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(runtime.updateUIState).toHaveBeenCalledTimes(before)
      expect(store.getUI()).toMatchObject({ filterRepoIds: ['same', Q], sortBy: 'name' })
    }
    expect(
      await send(
        { filterRepoIdsMode: 'exact', filterRepoIds: [Q, 'offline'], agentsFilterRepoIds: [] },
        caps
      )
    ).toMatchObject({ ok: true, result: { ui: { filterRepoIds: [Q, 'offline'] } } })
    expect(runtime.updateUIState.mock.calls.at(-1)?.[0]).toEqual({ filterRepoIds: [Q, 'offline'] })
    // Any unmarked socket uses the same legacy adapter. Lost reply + later Sort cannot resurrect an opaque token.
    store.updateUI({ filterRepoIds: ['same', Q] })
    await send({ filterRepoIds: [Q] }, caps)
    expect(store.getUI().filterRepoIds).toEqual([])
    await send({ filterRepoIds: [Q], sortBy: 'smart' }, caps)
    expect(store.getUI()).toMatchObject({ filterRepoIds: [], sortBy: 'smart' })
    // Owner-held offline echo survives; raw additions are unchanged; exact reselect is intentional.
    await send({ filterRepoIdsMode: 'exact', filterRepoIds: [Q] }, caps)
    await send({ filterRepoIds: [Q, 'added', 'added'] }, caps)
    expect(store.getUI().filterRepoIds).toEqual([Q, 'added'])
    await send({ filterRepoIdsMode: 'exact', filterRepoIds: [] }, caps)
    await send({ filterRepoIds: [Q, 'added'] }, caps)
    expect(store.getUI().filterRepoIds).toEqual(['added'])
    await send({ filterRepoIdsMode: 'exact', filterRepoIds: [Q] }, caps)
    expect(store.getUI().filterRepoIds).toEqual([Q])
  }
  store.flush()
  expect(readDataFile()).toHaveProperty('ui.filterRepoIds', [Q])
  expect(readDataFile()).not.toHaveProperty('ui.filterRepoIdsMode')
  await closeTestStores()
  expect(createStore().getUI().filterRepoIds).toEqual([Q])
})

it('saves the actual nested Hx edit exactly through native and marked RPC owners and serves normal containing keys', async () => {
  const target = { kind: 'environment', environmentId: 'E' } as const
  const authored = [
    { id: 'r', connectionId: 'x', executionHostId: 'ssh:x' as const, path: '/srv/r' },
    { id: 'r', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/r' },
    { id: 'q', connectionId: 'y', executionHostId: 'ssh:y' as const, path: '/srv/q' }
  ].map((repo) => ({
    ...repo,
    displayName: repo.path,
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }))
  const original = projectHostSetupProjectionFromRepos(authored)
  const projection = adoptEndpointProjectCatalog(target, original.projects, original.setups)
  const repos = authored.map((repo) => adoptEndpointRepo(target, repo))
  const settings = { projectGroupingMode: 'host' } as const
  const index = buildProjectGroupingIndex({
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings
  })
  const hx = index.groups.find((group) => group.registrations.includes(projection.setups[0]))!
  const hy = index.groups.find((group) => group.registrations.includes(projection.setups[1]))!
  const edited = editProjectFilter(index, ['offline'], { kind: 'complete', keys: [hx.key] })
  expect(edited).toEqual(['offline', 'ssh:x\0r'])
  writeDataFile({ ...getDefaultPersistedState(testState.dir), repos: authored })
  const store = createStore()
  registerUIHandlers(store)
  electron.handlers.get('ui:set')!({}, { filterRepoIds: edited })
  expect(store.getUI().filterRepoIds).toEqual(edited)
  store.flush()
  expect(readDataFile().ui.filterRepoIds).toEqual(edited)
  const runtime = new OrcaRuntimeService(store)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...CLIENT_UI_METHODS, ...MOBILE_PROJECT_SECTIONS_METHODS]
  })
  const published = buildMobileProjectSectionCatalog(
    repos,
    projection,
    'manual',
    [],
    settings,
    index
  )
  expect(publishMobileProjectSections(published)).toBe(true)
  expect(publishMobileProjectSections(published)).toBe(false)
  const reply = await dispatcher.dispatch({
    id: 'catalog',
    authToken: '',
    method: 'mobileRelay.projectSections'
  })
  expect(reply).toMatchObject({ ok: true })
  if (!reply.ok) {
    throw new Error('Missing normal project sections reply')
  }
  const result = reply.result
  if (!result || typeof result !== 'object' || !('catalog' in result)) {
    throw new Error('Missing catalog')
  }
  const served = ProjectSectionCatalogSchema.parse(result.catalog)
  expect(served.setups.map((setup) => setup.groupKey)).toEqual([hx.key, hy.key, hy.key])
  const accepted = await dispatcher.dispatch(
    {
      id: 'marked',
      authToken: '',
      method: 'ui.set',
      params: { filterRepoIds: edited, filterRepoIdsMode: 'exact' }
    },
    { clientKind: 'mobile', clientCapabilities: [...MOBILE_RUNTIME_CLIENT_CAPABILITIES] }
  )
  expect(accepted).toMatchObject({ ok: true })
  expect(store.getUI().filterRepoIds).toEqual(edited)
  const matches = projectRepoFilterMatcher(store.getUI().filterRepoIds)
  expect([matches('r', 'ssh:x'), matches('r', 'ssh:y'), matches('q', 'ssh:y')]).toEqual([
    true,
    false,
    false
  ])
  expect(projectFilterSelection(index, store.getUI().filterRepoIds)).toMatchObject({
    fullKeys: [hx.key],
    unresolved: ['offline']
  })
  store.flush()
  expect(readDataFile().ui.filterRepoIds).toEqual(edited)
  await closeTestStores()
  const restored = createStore().getUI().filterRepoIds
  // Hydration may prune absent literal raw ids; the existing qualified physical address survives while r exists.
  expect(restored).toContain('ssh:x\0r')
  expect(projectRepoFilterMatcher(restored)('r', 'ssh:y')).toBe(false)
})

it.each([100, 1000])(
  'counts the real exact owner sends, results and saved filter targets at N=%i',
  async (n) => {
    const authored = Array.from({ length: n }, (_, i) => ({
      id: 'r',
      connectionId: `h${i}`,
      executionHostId: `ssh:h${i}` as const,
      path: `/srv/${i}`,
      displayName: `Repo ${i}`,
      badgeColor: '',
      addedAt: 0
    }))
    writeDataFile({ ...getDefaultPersistedState(testState.dir), repos: authored })
    const store = createStore()
    const runtime = new OrcaRuntimeService(store)
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const writes = vi.spyOn(store, 'updateUI')
    for (const q of [1, 2, n]) {
      const source = authored.map((repo, i) => ({
        ...repo,
        upstream: { owner: 'org', repo: i < q ? 'target' : `app-${i}` }
      }))
      const original = projectHostSetupProjectionFromRepos(source)
      const target = { kind: 'environment', environmentId: 'E' } as const
      const projection = adoptEndpointProjectCatalog(target, original.projects, original.setups)
      const index = buildProjectGroupingIndex({
        projects: projection.projects,
        projectHostSetups: projection.setups
      })
      const group = index.groups.find((candidate) =>
        candidate.registrations.includes(projection.setups[0])
      )!
      const produced = editProjectFilter(index, ['offline'], {
        kind: 'complete',
        keys: [group.key]
      })
      expect(produced).toEqual([
        'offline',
        ...(q === n ? ['r'] : Array.from({ length: q }, (_, i) => `ssh:h${i}\0r`))
      ])
      const before = writes.mock.calls.length
      const response = await dispatcher.dispatch(
        {
          id: `q-${q}`,
          authToken: '',
          method: 'ui.set',
          params: { filterRepoIds: produced, filterRepoIdsMode: 'exact' }
        },
        { clientKind: 'mobile', clientCapabilities: [...MOBILE_RUNTIME_CLIENT_CAPABILITIES] }
      )
      expect(response).toMatchObject({ ok: true, result: { ui: { filterRepoIds: produced } } })
      expect(writes.mock.calls.length - before).toBe(1)
      expect(writes.mock.calls.at(-1)?.[0].filterRepoIds).toEqual(produced)
      expect(store.getUI().filterRepoIds).toEqual(produced)
      store.flush()
      expect(readDataFile().ui.filterRepoIds).toEqual(produced)
      const matches = projectRepoFilterMatcher(store.getUI().filterRepoIds)
      const included = authored.filter((repo) => matches(repo.id, repo.executionHostId))
      expect(included).toEqual(authored.slice(0, q))
      process.stdout.write(
        `F1 owner ${JSON.stringify({ n, q, sends: writes.mock.calls.length - before, returned: response.ok, savedTokens: readDataFile().ui.filterRepoIds.length, included: included.length })}\n`
      )
    }
    writes.mockRestore()
  }
)
