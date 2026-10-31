import '../../../src/main/persistence/applying-settings/mobile-project-controls-host.test-fixture'
import { doubles } from './mobile-web-shell-protocol-test-fixtures'
import {
  type Mounted,
  HOST_ID,
  ROUTE_PATHNAME,
  ROUTE_PATTERN,
  GOOD_BUILD_ID,
  NEWER_MANIFEST,
  cacheGeneration,
  refuseTheAssets,
  mountRoute
} from './mobile-web-shell-route-test-fixtures'
import { createElement, useEffect } from 'react'
import { type ReactTestRenderer, act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import WebSocket from 'ws'
import {
  closeTestStores,
  createStore,
  readPersistedState
} from '../../../src/main/persistence/persistence-test-harness'
import { createProjectGroupingSocketOwner } from '../../../src/main/persistence/applying-settings/project-grouping-socket-owner.test-fixture'
import { DirectRpcClient } from '../transport/direct-rpc-client'
import { createBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import { useHostStatusGates } from '../transport/host-status-gates'
import {
  HostStatusGatesContext,
  useOptionalHostProtocolGates
} from '../components/host-protocol-gates-context'
import { useHostScreenState } from '../host-screen/use-host-screen-state'
import { useHostViewSettings } from '../host-screen/use-host-view-settings'
import { useHostViewSettings as useReleasedSettings } from '../host-screen/project-grouping-released-view-settings.test-fixture'
import { ProjectsPage as ReleasedProjectsPage } from '../host-screen/project-grouping-released-project-page.test-fixture'
import { WORKSPACE_OPTION_CONTROLS } from '../host-screen/workspace-option-controls'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildFilterRepos } from '../worktree/workspace-filter-repos'
import type { RpcClient } from '../transport/rpc-client'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
it.each(['released-page/current-native', 'current-page/released-native'] as const)(
  'joins failed-download compatible cache, %s controls, opaque bridge, auth and disk',
  async (composition) => {
    expect(ORCA_SIDEBAR_INPUTS_IS_MAIN).toBe(false)
    const owner = await createProjectGroupingSocketOwner({ deviceScope: 'mobile' })
    vi.stubGlobal('WebSocket', WebSocket)
    const endpoint = owner.environment.endpoints[0]
    // Physical sender and opaque bridge are byte-identical to the released version; pins are in review evidence.
    const direct = new DirectRpcClient(
      endpoint.endpoint,
      endpoint.deviceToken,
      endpoint.publicKeyB64,
      {}
    )
    const Q = 'runtime:server\0same'
    const renders: ReactTestRenderer[] = []
    const controlFrames = new Map<RpcClient, unknown>()
    let cached: Mounted | undefined
    let pair: ReturnType<typeof createBridgePortPair> | undefined
    const catalogRepos = [
      {
        id: 'same',
        displayName: 'Local',
        path: '/local',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'same',
        displayName: 'Server',
        upstream: { owner: 'org', repo: 'app' },
        path: '/server',
        executionHostId: 'runtime:server' as const,
        badgeColor: '',
        addedAt: 0
      }
    ]
    const projection = projectHostSetupProjectionFromRepos(catalogRepos)
    const groupedRepos = buildFilterRepos(catalogRepos, [], {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: 'folder' }
    })
    const rawRepos = buildFilterRepos(catalogRepos, [])
    const mountControls = async (client: RpcClient, released: boolean) => {
      const SelectedControl = released
        ? ReleasedProjectsPage
        : WORKSPACE_OPTION_CONTROLS.projects.kind === 'page'
          ? WORKSPACE_OPTION_CONTROLS.projects.Page
          : null
      if (!SelectedControl) {
        throw new Error('Missing Project page')
      }
      const Control = SelectedControl
      function GateOwner() {
        const gates = useHostStatusGates({
          client,
          hostId: HOST_ID,
          connState: client.getState()
        })
        return createElement(
          HostStatusGatesContext.Provider,
          { value: gates },
          createElement(Controls)
        )
      }
      function Controls() {
        const gates = useOptionalHostProtocolGates()
        const state = useHostScreenState(HOST_ID)
        const current = useHostViewSettings({ client, connState: 'connected', state })
        const old = useReleasedSettings({ client, connState: 'connected', state })
        const settings = released ? old : current
        controlFrames.set(client, {
          released,
          selected: state.view.filters.filterRepoIds,
          ready: current.projectRepoFiltersReady,
          actionError: state.actionError,
          statusPending: gates?.statusPending,
          statusReadable: gates?.statusReadable,
          support: gates?.projectRepoFilterSupport,
          generation: gates?.statusGeneration
        })
        useEffect(() => {
          state.clientRef.current = client
          void settings.syncViewSettingsFromDesktop()
        }, [client])
        const projectPagePort = {
          state,
          settings,
          sectionsResult: { uniqueRepos: released ? rawRepos : groupedRepos }
        } satisfies {
          state: HostScreenController['state']
          settings: Pick<HostScreenController['settings'], 'setFilter' | 'toggleRepoFilter'> &
            Partial<
              Pick<
                HostScreenController['settings'],
                'projectRepoFiltersReady' | 'projectRepoFilterMeaning'
              >
            >
          sectionsResult: Pick<HostScreenController['sectionsResult'], 'uniqueRepos'>
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked actual Projects state/settings/catalog port above; unused host-screen controller sections are not implemented.
        const controller = projectPagePort as unknown as HostScreenController
        return createElement(Control, { controller, hosts: [], label: 'Projects' })
      }
      let tree!: ReactTestRenderer
      await act(async () => {
        tree = create(createElement(GateOwner))
      })
      renders.push(tree)
      return tree
    }
    const press = async (tree: ReactTestRenderer, label: string) => {
      const row = () =>
        tree.root.findByProps({
          accessibilityLabel: label,
          accessibilityRole: 'checkbox'
        })
      await vi.waitFor(() => expect(row().props.disabled).not.toBe(true))
      await act(async () => row().props.onPress())
    }
    try {
      await vi.waitFor(() => expect(direct.getState()).toBe('connected'))
      doubles.connection = { client: direct, state: 'connected' }
      doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
      doubles.manifest = NEWER_MANIFEST
      doubles.fetch = refuseTheAssets
      const fileSystem = createFakeGenerationFileSystem()
      await cacheGeneration(fileSystem)
      cached = await mountRoute(fileSystem)
      expect(cached.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
      expect(cached.updateNotice()).toBe('update-failed')
      pair = createBridgePortPair({
        rpc: direct,
        buildId: GOOD_BUILD_ID,
        route: { pathname: ROUTE_PATHNAME },
        pageRoutes: [ROUTE_PATTERN],
        sessionEstablished: true
      })
      await pair.flush()
      owner.store.updateUI({ filterRepoIds: ['same', Q] })
      const page = await mountControls(pair.client, composition.startsWith('released'))
      await vi.waitFor(() =>
        expect(
          page.root.findByProps({ accessibilityLabel: 'Local', accessibilityRole: 'checkbox' })
            .props.accessibilityState.checked
        ).toBe(true)
      )
      await press(page, 'Local')
      await vi.waitFor(() =>
        expect(owner.store.getUI().filterRepoIds).toEqual(
          composition.startsWith('released') ? [] : [Q]
        )
      )
      const pageEdit = owner.requests.findLast((r) => r.method === 'ui.set')
      expect(pageEdit?.params).toEqual(
        composition.startsWith('released')
          ? { filterRepoIds: [Q] }
          : { filterRepoIds: [Q], filterRepoIdsMode: 'exact' }
      )
      owner.store.updateUI({ filterRepoIds: [] })
      const native = await mountControls(direct, composition.endsWith('released-native'))
      expect(
        native.root.findByProps({
          accessibilityLabel: 'Server',
          accessibilityRole: 'checkbox'
        }).props.accessibilityState.checked
      ).toBe(false)
      await press(native, 'Server')
      await vi.waitFor(() =>
        expect(owner.requests.findLast((r) => r.method === 'ui.set')?.params).toEqual(
          composition.endsWith('released-native')
            ? { filterRepoIds: ['same'] }
            : { filterRepoIds: [Q], filterRepoIdsMode: 'exact' }
        )
      )
      await vi.waitFor(() =>
        expect(owner.store.getUI().filterRepoIds).toEqual(
          composition.endsWith('released-native') ? ['same'] : [Q]
        )
      )
      // Same physical socket's old raw re-entry never inherits another writer's exact meaning.
      await pair.client.sendRequest('ui.set', { filterRepoIds: [] })
      expect(owner.store.getUI().filterRepoIds).toEqual([])
      expect(
        owner.auth.every((entry) => !entry.capabilities.includes('ui.project-repo-filter-exact.v1'))
      ).toBe(true)
      const installs = owner.requests.filter(
        (r) => r.method === 'runtime.clientCapabilities.update'
      )
      expect(
        installs.every((r) => !JSON.stringify(r.params).includes('ui.project-repo-filter-exact'))
      ).toBe(true)
      owner.store.flush()
      expect(readPersistedState().ui).not.toHaveProperty('filterRepoIdsMode')
      await closeTestStores()
      expect(createStore().getUI().filterRepoIds).toEqual([])
    } catch (error) {
      console.info(
        'PG35595 mixed-composition failure',
        JSON.stringify({
          composition,
          controls: [...controlFrames.values()],
          writes: owner.requests.filter((request) => request.method === 'ui.set'),
          ownerFilter: owner.store.getUI().filterRepoIds
        })
      )
      throw error
    } finally {
      await act(async () => renders.forEach((tree) => tree.unmount()))
      await cached?.unmount()
      pair?.client.close()
      pair?.host.dispose()
      direct.close()
      await owner.close()
      vi.unstubAllGlobals()
    }
  },
  20_000
)

it.each(['exact', 'legacy'] as const)(
  'keeps catalog-less Projects %s edits bound to the real status and pending socket owner',
  async (meaning) => {
    const delayedStatus: (() => void)[] = []
    const delayedWrites: (() => void)[] = []
    const owner = await createProjectGroupingSocketOwner({
      deviceScope: 'mobile',
      response: (method, response) => {
        if (meaning !== 'legacy' || method !== 'status.get') {
          return response
        }
        const reply = JSON.parse(response)
        reply.result.capabilities = reply.result.capabilities.filter(
          (capability: string) => capability !== 'ui.project-repo-filter-exact.v1'
        )
        return JSON.stringify(reply)
      },
      deliver: (method, response, reply) => {
        const deliver = () => reply(response)
        if (method === 'status.get') {
          delayedStatus.push(deliver)
        } else if (method === 'ui.set') {
          delayedWrites.push(deliver)
        } else {
          deliver()
        }
      }
    })
    vi.stubGlobal('WebSocket', WebSocket)
    const endpoint = owner.environment.endpoints[0]
    const direct = new DirectRpcClient(
      endpoint.endpoint,
      endpoint.deviceToken,
      endpoint.publicKeyB64,
      {}
    )
    const Q = 'runtime:server\0same'
    const repos = [
      {
        id: 'same',
        displayName: 'Local',
        path: '/local',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'same',
        displayName: 'Server',
        path: '/server',
        executionHostId: 'runtime:server' as const,
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      }
    ]
    const rawOptions = buildFilterRepos(repos, [])
    let options = rawOptions
    let tree: ReactTestRenderer | undefined
    let successorOwner: Awaited<ReturnType<typeof createProjectGroupingSocketOwner>> | undefined
    let successorClient: DirectRpcClient | undefined
    let currentSettings: HostScreenController['settings'] | undefined
    const successorAcks: (() => void)[] = []
    const Control =
      WORKSPACE_OPTION_CONTROLS.projects.kind === 'page'
        ? WORKSPACE_OPTION_CONTROLS.projects.Page
        : null
    if (!Control) {
      throw new Error('Missing Projects page')
    }
    function Controls({ client }: { client: RpcClient }) {
      const state = useHostScreenState(HOST_ID)
      const settings = useHostViewSettings({ client, connState: 'connected', state })
      useEffect(() => {
        state.clientRef.current = client
        void settings.syncViewSettingsFromDesktop()
      }, [client])
      currentSettings = settings
      const projectPagePort = {
        state,
        settings,
        sectionsResult: {
          uniqueRepos: settings.projectRepoFilterMeaning === 'exact' ? options : rawOptions
        }
      } satisfies {
        state: HostScreenController['state']
        settings: HostScreenController['settings']
        sectionsResult: Pick<HostScreenController['sectionsResult'], 'uniqueRepos'>
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked actual Projects state/settings/catalog port above; unused host-screen controller sections are not implemented.
      const controller = projectPagePort as unknown as HostScreenController
      return createElement(Control!, { controller, hosts: [], label: 'Projects' })
    }
    function GateOwner({ client }: { client: RpcClient }) {
      const gates = useHostStatusGates({ client, hostId: HOST_ID, connState: 'connected' })
      return createElement(
        HostStatusGatesContext.Provider,
        { value: gates },
        createElement(Controls, { client })
      )
    }
    try {
      await vi.waitFor(() => expect(direct.getState()).toBe('connected'))
      owner.store.updateUI({
        filterRepoIds: meaning === 'exact' ? [Q, 'offline'] : ['same', 'offline']
      })
      await act(async () => {
        tree = create(createElement(GateOwner, { client: direct }))
      })
      const remote = () =>
        tree!.root.findByProps({ accessibilityLabel: 'Server', accessibilityRole: 'checkbox' })
      expect(remote().props.disabled).toBe(true)
      expect(owner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(0)
      await vi.waitFor(() => expect(delayedStatus.length).toBeGreaterThan(0))
      await act(async () => {
        delayedStatus.splice(0).forEach((deliver) => deliver())
      })
      await vi.waitFor(() => expect(remote().props.disabled).not.toBe(true))
      expect(remote().props.accessibilityState.checked).toBe(true)
      await act(async () => remote().props.onPress())
      await vi.waitFor(() =>
        expect(owner.requests.findLast((request) => request.method === 'ui.set')?.params).toEqual({
          filterRepoIds: ['offline'],
          ...(meaning === 'exact' ? { filterRepoIdsMode: 'exact' } : {})
        })
      )
      // Catalog publication while the write acknowledgement is outstanding cannot relabel its authored meaning.
      const projection = projectHostSetupProjectionFromRepos(repos)
      options = buildFilterRepos(repos, [], {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        settings: { projectGroupingMode: 'folder' }
      })
      expect(options.map((option) => option.name)).toEqual(['Local', 'Server'])
      expect(
        options.map((option) =>
          option.grouping?.groupByKey.get(option.key)?.registrations.map((setup) => ({
            repoId: setup.repoId,
            hostId: setup.hostId,
            path: setup.path
          }))
        )
      ).toEqual([
        [{ repoId: 'same', hostId: 'local', path: '/local' }],
        [{ repoId: 'same', hostId: 'runtime:server', path: '/server' }]
      ])
      await act(async () => tree!.update(createElement(GateOwner, { client: direct })))
      await vi.waitFor(() => expect(delayedWrites).toHaveLength(1))
      const originalAck = delayedWrites.shift()!
      await vi.waitFor(() => expect(owner.store.getUI().filterRepoIds).toEqual(['offline']))
      expect(owner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(1)
      owner.store.flush()
      expect(readPersistedState().ui.filterRepoIds).toEqual(['offline'])
      expect(readPersistedState().ui).not.toHaveProperty('filterRepoIdsMode')

      successorOwner = await createProjectGroupingSocketOwner({
        deviceScope: 'mobile',
        response: (method, response) => {
          if (meaning !== 'legacy' || method !== 'status.get') {
            return response
          }
          const reply = JSON.parse(response)
          reply.result.capabilities = reply.result.capabilities.filter(
            (capability: string) => capability !== 'ui.project-repo-filter-exact.v1'
          )
          return JSON.stringify(reply)
        },
        deliver: (method, response, reply) => {
          if (method === 'ui.set') {
            successorAcks.push(() => reply(response))
          } else {
            reply(response)
          }
        }
      })
      const nextEndpoint = successorOwner.environment.endpoints[0]
      successorClient = new DirectRpcClient(
        nextEndpoint.endpoint,
        nextEndpoint.deviceToken,
        nextEndpoint.publicKeyB64,
        {}
      )
      await vi.waitFor(() => expect(successorClient!.getState()).toBe('connected'))
      successorOwner.store.updateUI({
        filterRepoIds:
          meaning === 'exact' ? [Q, 'successor-offline'] : ['same', 'successor-offline']
      })
      // Retain the real hook/page instance while its logical writer/authority changes.
      await act(async () => tree!.update(createElement(GateOwner, { client: successorClient! })))
      await vi.waitFor(() => expect(remote().props.disabled).not.toBe(true))
      await vi.waitFor(() => expect(remote().props.accessibilityState.checked).toBe(true))
      expect(successorOwner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(
        0
      )
      await act(async () => remote().props.onPress())
      await vi.waitFor(() => expect(successorAcks).toHaveLength(1))
      expect(
        successorOwner.requests.findLast((request) => request.method === 'ui.set')?.params
      ).toEqual({
        filterRepoIds: ['successor-offline'],
        ...(meaning === 'exact' ? { filterRepoIdsMode: 'exact' } : {})
      })
      const successorPending = currentSettings!.pendingViewChanges.pending.map(
        (change) => change.opId
      )
      if (meaning === 'exact') {
        expect(successorPending).toHaveLength(1)
      }
      await act(async () => originalAck())
      expect(remote().props.accessibilityState.checked).toBe(false)
      expect(currentSettings!.pendingViewChanges.pending.map((change) => change.opId)).toEqual(
        successorPending
      )
      expect(owner.store.getUI().filterRepoIds).toEqual(['offline'])
      expect(successorOwner.store.getUI().filterRepoIds).toEqual(['successor-offline'])
      expect(successorOwner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(
        1
      )
      expect(owner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(1)
      await act(async () => successorAcks.splice(0).forEach((deliver) => deliver()))
      await vi.waitFor(() => expect(currentSettings!.pendingViewChanges.pending).toEqual([]))
      successorOwner.store.flush()
      expect(readPersistedState().ui.filterRepoIds).toEqual(['successor-offline'])
      expect(readPersistedState().ui).not.toHaveProperty('filterRepoIdsMode')
    } finally {
      await act(async () => {
        tree?.unmount()
        delayedWrites.splice(0).forEach((deliver) => deliver())
        delayedStatus.splice(0).forEach((deliver) => deliver())
        successorAcks.splice(0).forEach((deliver) => deliver())
      })
      successorClient?.close()
      await successorOwner?.close()
      direct.close()
      await owner.close()
      vi.unstubAllGlobals()
    }
  },
  20_000
)
