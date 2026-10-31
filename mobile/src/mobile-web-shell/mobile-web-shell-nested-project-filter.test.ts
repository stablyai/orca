import '../../../src/main/persistence/applying-settings/mobile-project-controls-host.test-fixture'
import { HOST_ID } from './mobile-web-shell-route-test-fixtures'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../src/shared/endpoint-catalog-adoption'
import { buildProjectGroupingIndex } from '../../../src/shared/project-section-grouping'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { publishMobileProjectSections } from '../../../src/main/runtime/mobile-project-sections-snapshot'
import { readServedProjectSections } from '../worktree/project-sections-operations'
import { buildProjectSectionCatalog } from '../worktree/project-section-catalog'
import { filterWorktrees } from '../worktree/workspace-list-sections'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { createElement, useEffect } from 'react'
import { type ReactTestRenderer, act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { readDataFile } from '../../../src/main/persistence/persistence-test-harness'
import { createProjectGroupingSocketOwner } from '../../../src/main/persistence/applying-settings/project-grouping-socket-owner.test-fixture'
import { DirectRpcClient } from '../transport/direct-rpc-client'
import { useHostStatusGates } from '../transport/host-status-gates'
import { HostStatusGatesContext } from '../components/host-protocol-gates-context'
import { useHostScreenState } from '../host-screen/use-host-screen-state'
import { useHostViewSettings } from '../host-screen/use-host-view-settings'
import { WORKSPACE_OPTION_CONTROLS } from '../host-screen/workspace-option-controls'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildFilterRepos } from '../worktree/workspace-filter-repos'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
// Keep the integration bound for real encrypted RPC, held ACKs and persisted-state settlement.
it('joins normally published nested Hx through the actual Projects pending writer and marked owner', async () => {
  const acknowledgements: (() => void)[] = []
  const owner = await createProjectGroupingSocketOwner({
    deviceScope: 'mobile',
    deliver: (method, response, reply) => {
      if (method === 'ui.set') {
        acknowledgements.push(() => reply(response))
      } else {
        reply(response)
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
  const published = buildMobileProjectSectionCatalog(
    repos,
    projection,
    'manual',
    [],
    settings,
    index
  )
  publishMobileProjectSections(published)
  let options: ReturnType<typeof buildFilterRepos> = []
  let currentSettings: HostScreenController['settings'] | undefined
  let tree: ReactTestRenderer | undefined
  const Control =
    WORKSPACE_OPTION_CONTROLS.projects.kind === 'page'
      ? WORKSPACE_OPTION_CONTROLS.projects.Page
      : null
  if (!Control) {
    throw new Error('Missing Projects page')
  }
  function Controls() {
    const state = useHostScreenState(HOST_ID)
    const view = useHostViewSettings({ client: direct, connState: 'connected', state })
    useEffect(() => {
      state.clientRef.current = direct
      void view.syncViewSettingsFromDesktop()
    }, [])
    currentSettings = view
    const port = { state, settings: view, sectionsResult: { uniqueRepos: options } } satisfies {
      state: HostScreenController['state']
      settings: HostScreenController['settings']
      sectionsResult: Pick<HostScreenController['sectionsResult'], 'uniqueRepos'>
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked actual Projects consumed port; this fixture does not implement unrelated controller sections.
    const controller = port as unknown as HostScreenController
    return createElement(Control!, { controller, hosts: [], label: 'Projects' })
  }
  function GateOwner() {
    const gates = useHostStatusGates({ client: direct, hostId: HOST_ID, connState: 'connected' })
    return createElement(HostStatusGatesContext.Provider, { value: gates }, createElement(Controls))
  }
  try {
    await vi.waitFor(() => expect(direct.getState()).toBe('connected'))
    const answer = readServedProjectSections(
      await direct.sendRequest('mobileRelay.projectSections')
    )
    if (answer.kind !== 'answered' || !answer.value) {
      throw new Error('Missing normal served project sections')
    }
    const catalog = buildProjectSectionCatalog(answer.value, repos, null, null)
    options = buildFilterRepos(catalog.repos, [], catalog.grouping)
    expect(options[0].key).toBe(hx.key)
    expect(options).toHaveLength(2)
    expect(
      owner.requests.filter((request) => request.method === 'mobileRelay.projectSections')
    ).toHaveLength(1)
    owner.store.updateUI({ filterRepoIds: ['offline'] })
    await act(async () => {
      tree = create(createElement(GateOwner))
    })
    const first = () =>
      tree!.root.findAllByProps({
        accessibilityLabel: options[0].name,
        accessibilityRole: 'checkbox'
      })[0]
    await vi.waitFor(() => expect(first().props.disabled).not.toBe(true))
    expect(first().props.accessibilityState.checked).toBe(false)
    await act(async () => first().props.onPress())
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(1))
    expect(owner.requests.filter((request) => request.method === 'ui.set')).toHaveLength(1)
    expect(owner.requests.findLast((request) => request.method === 'ui.set')?.params).toEqual({
      filterRepoIds: ['offline', 'ssh:x\0r'],
      filterRepoIdsMode: 'exact'
    })
    expect(owner.store.getUI().filterRepoIds).toEqual(['offline', 'ssh:x\0r'])
    const pending = currentSettings!.pendingViewChanges.pending.map((change) => change.opId)
    expect(pending).toHaveLength(1)
    expect(first().props.accessibilityState.checked).toBe(true)
    const rows = [
      { worktreeId: 'wx', repoId: 'r', hostId: 'ssh:x' as const },
      { worktreeId: 'wy', repoId: 'r', hostId: 'ssh:y' as const },
      { worktreeId: 'wq', repoId: 'q', hostId: 'ssh:y' as const }
    ].map((row) => ({
      ...row,
      repo: 'app',
      branch: '',
      displayName: row.worktreeId,
      path: `/srv/${row.worktreeId}`,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unread: false,
      isPinned: false,
      linkedPR: null
    }))
    expect(
      filterWorktrees(
        rows,
        { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: owner.store.getUI().filterRepoIds },
        ''
      ).map((row) => row.worktreeId)
    ).toEqual(['wx'])
    await act(async () => acknowledgements.splice(0).forEach((deliver) => deliver()))
    await vi.waitFor(() => expect(currentSettings!.pendingViewChanges.pending).toEqual([]))
    owner.store.flush()
    expect(readDataFile().ui.filterRepoIds).toEqual(['offline', 'ssh:x\0r'])
    expect(readDataFile().ui).not.toHaveProperty('filterRepoIdsMode')
  } finally {
    await act(async () => {
      tree?.unmount()
      acknowledgements.splice(0).forEach((deliver) => deliver())
    })
    direct.close()
    await owner.close()
    vi.unstubAllGlobals()
  }
}, 20_000)
