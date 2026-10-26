import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { HostStatusGatesContext } from '../components/host-protocol-gates-context'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { RpcResponse } from '../transport/types'
import { relayHostsFeed } from '../worktree/relay-hosts-feed'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import { getTaskRepoDetail } from './mobile-tasks-repository-presentation'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'

const desktopRef: { current: FakeSession | null } = { current: null }
const savedSelectionRef: { current: string[] } = { current: [] }
const savedSettingsRef: { current: Record<string, unknown> } = { current: {} }

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, hairlineWidth: 1 }
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => async () => {} }))
const surface: { model?: ConnectionPresentationModel } = {}
vi.mock('./MobileTasksLegacySurface', () => ({
  MobileTasksLegacySurface: ({ model }: { model: ConnectionPresentationModel }) => {
    surface.model = model
    renders.push({
      loading: model.loading,
      refreshing: model.refreshing,
      count: model.items.length
    })
    return null
  }
}))
vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const pure = {
    useCallback: react.useCallback,
    useEffect: react.useEffect,
    useLayoutEffect: react.useLayoutEffect,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useState: react.useState,
    StyleSheet: { create: <Styles,>(styles: Styles) => styles, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    ...(await import('../theme/mobile-theme')),
    ...(await import('./use-host-repo-list')),
    ...(await import('./host-repo-list')),
    ...(await import('../../../src/shared/task-providers')),
    ...(await import('./hosted-repo-selection')),
    ...(await import('../../../src/shared/work-items')),
    ...(await import('./github-work-item-source-errors')),
    ...(await import('./github-project-repo-match')),
    ...(await import('./github-project-reference')),
    ...(await import('./mobile-tasks-capability')),
    ...(await import('./setup-hook-trust')),
    ...(await import('./mobile-task-copy-feedback-timer')),
    ...(await import('./github-pr-file-diff')),
    ...(await import('./github-check-summary')),
    ...(await import('./gitlab-check-summary')),
    ...(await import('./mobile-hosted-check-status')),
    ...(await import('./workspace-create-params')),
    ...(await import('./workspace-agent-selection')),
    ...(await import('./hosted-review-start-point')),
    ...(await import('./mobile-workspace-name')),
    ...(await import('./sparse-preset-draft')),
    ...(await import('./workspace-ssh-gate')),
    ...(await import('./workspace-create-timeout')),
    ...(await import('./mobile-tui-agents')),
    ...(await import('./mobile-composer-branch-selection')),
    ...(await import('../transport/connection-health')),
    useHostClient: () => ({ client: desktopRef.current, state: desktopRef.current?.getState() }),
    useLocalSearchParams: () => ({ hostId: 'mac' }),
    useRouter: () => ({}),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useReconnectAttempt: () => 0,
    useLastConnectedAt: () => null,
    useRelayRecoveryStatus: () => null
  }
  const renderNothing = () => null
  const exports = new Map<string | symbol, unknown>(Object.entries(pure))
  return new Proxy(pure, {
    has: (target, key) => key !== 'then' && (key in target || typeof key === 'string'),
    get: (_target, key) =>
      exports.has(key) || typeof key !== 'string' || key === 'then'
        ? exports.get(key)
        : renderNothing
  })
})

const { MobileTasksScreen } = await import('./MobileTasksScreen')

type Sent = { method: string; params?: unknown; executionHost?: string }
const sentBy = new WeakMap<FakeSession, Sent[]>()

function recording(
  client: FakeSession,
  answer: (method: string, executionHost: string | undefined) => Promise<RpcResponse>
): FakeSession {
  const sent: Sent[] = []
  sentBy.set(client, sent)
  client.sendRequest.mockImplementation(
    async (
      method: string,
      params?: unknown,
      options?: { envelope?: { executionHost?: string } }
    ) => {
      sent.push({ method, params, executionHost: options?.envelope?.executionHost })
      return answer(method, options?.envelope?.executionHost)
    }
  )
  return client
}

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const MAC_REPOS = [{ id: 'mac-repo', displayName: 'app', path: '/mac/app' }]
const VM_REPOS = [
  { id: 'vm-repo', displayName: 'api', path: '/srv/api' },
  { id: 'vm-ssh-repo', displayName: 'remote', path: '/r', connectionId: 'vm-ssh' }
]
const HOSTS = [
  { hostId: 'runtime:vm', label: 'VM', health: 'available', relay: 'ready' },
  { hostId: 'runtime:old', label: 'ThinkPad', health: 'available', relay: 'update-needed' }
]

function issue(title: string) {
  return {
    id: title,
    type: 'issue',
    number: 1,
    title,
    state: 'open',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    updatedAt: '2026-10-11T00:00:00Z',
    author: null
  }
}

function desktop(
  vmRepoList: () => Promise<unknown> = async () => ({ repos: VM_REPOS }),
  hostsList: () => Promise<unknown> = async () => ({ hosts: HOSTS }),
  jiraStatus: () => Promise<RpcResponse> = async () => reply({})
): FakeSession {
  return recording(new FakeSession('connected'), async (method, executionHost) => {
    if (method === 'jira.status') {
      return jiraStatus()
    }
    if (method === 'mobileRelay.hosts.list') {
      return reply(await hostsList())
    }
    if (method === 'status.get') {
      return reply({ capabilities: [MOBILE_TASKS_CAPABILITY] })
    }
    if (method === 'settings.get') {
      return reply({
        settings: { ...savedSettingsRef.current, defaultRepoSelection: savedSelectionRef.current }
      })
    }
    if (method === 'linear.status') {
      return reply({ connected: true })
    }
    if (method === 'linear.listIssues') {
      return reply([])
    }
    if (method === 'github.listWorkItems') {
      return reply({ items: [issue(executionHost ? 'from the server' : 'from the desktop')] })
    }
    if (method !== 'repo.list') {
      return reply({})
    }
    if (executionHost !== 'runtime:vm') {
      return reply({ repos: executionHost ? [] : MAC_REPOS })
    }
    return reply(await vmRepoList())
  })
}

const renders: { loading: boolean; refreshing: boolean; count: number }[] = []
const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

async function mount(
  client: FakeSession,
  hostCapabilities: string[],
  savedSelection: string[] = [],
  savedSettings: Record<string, unknown> = {}
): Promise<() => ConnectionPresentationModel> {
  desktopRef.current = client
  savedSelectionRef.current = savedSelection
  savedSettingsRef.current = savedSettings
  const gates: HostStatusGates = {
    hostCapabilities,
    floatingWorkspaceEnabled: false,
    desktopAppVersion: null,
    compatVerdict: { kind: 'ok' },
    hostProtocolWindow: { protocolVersion: undefined, minCompatibleMobileVersion: undefined },
    statusPending: false,
    statusReadable: true
  }
  await act(async () => {
    mounted.push(
      create(
        createElement(
          HostStatusGatesContext.Provider,
          { value: gates },
          createElement(MobileTasksScreen)
        )
      )
    )
  })
  return () => surface.model!
}

async function loadRepos(model: () => ConnectionPresentationModel): Promise<unknown> {
  const loaded: { repos?: unknown } = {}
  await act(async () => {
    loaded.repos = await model().repoListEnsureLoaded()
  })
  return loaded.repos
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const VM_REPO = {
  id: 'vm-repo',
  displayName: 'api',
  path: '/srv/api',
  executionHostId: 'runtime:vm'
}

function ranOn(client: FakeSession, method: string): string[] {
  return (sentBy.get(client) ?? [])
    .filter((sent) => sent.method === method)
    .map((sent) => sent.executionHost ?? 'desktop')
}

describe('Tasks screen repos on the desktop and its servers', () => {
  it('hydrates other providers while Jira status is pending and ignores the previous host reply', async () => {
    const jiraStatus = deferred<RpcResponse>()
    const client = desktop(undefined, undefined, () => jiraStatus.promise)
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await settle()
    expect(model().taskStateHydrated).toBe(true)
    expect(titles(model)).toContain('from the desktop')

    await act(async () => {
      desktopRef.current = desktop()
      model().setShowRepoPicker(true)
    })
    await settle()
    const nextConnection = model().jiraConnection
    jiraStatus.resolve(reply({ connected: true, sites: [] }))
    await settle()
    expect(model().jiraConnection).toEqual(nextConnection)
  })

  it('clears the previous desktop Jira connection while the next status is pending', async () => {
    const site = {
      id: 'desktop-a-site',
      siteUrl: 'https://a.atlassian.net',
      displayName: 'Desktop A',
      deployment: 'cloud' as const
    }
    const model = await mount(
      desktop(undefined, undefined, async () => reply({ connected: true, sites: [site] })),
      [],
      [],
      { defaultTaskSource: 'jira' }
    )
    await settle()
    expect(model().jiraConnection).toMatchObject({ connected: true, selection: site.id })
    const status = deferred<RpcResponse>()
    const nextDesktop = desktop(undefined, undefined, () => status.promise)
    await act(async () => {
      desktopRef.current = nextDesktop
      model().setShowRepoPicker(true)
    })
    await settle()
    expect(model().taskStateHydrated).toBe(true)
    expect(model().jiraConnection).toMatchObject({ connected: false, sites: [], selection: null })
    expect(ranOn(nextDesktop, 'jira.listIssues')).toEqual([])
    status.resolve(reply({ connected: false }))
    await settle()
  })

  it('keeps the newer explicit Jira status when an initial probe arrives late', async () => {
    const probe = deferred<RpcResponse>()
    let requests = 0
    const client = desktop(undefined, undefined, () => {
      requests += 1
      return requests === 1 ? probe.promise : Promise.resolve(reply({ connected: true }))
    })
    const model = await mount(client, [])
    await settle()
    await act(async () => {
      await model().refreshJiraConnection()
    })
    expect(model().jiraConnection.connected).toBe(true)
    probe.resolve(reply({ connected: false }))
    await settle()
    expect(model().jiraConnection.connected).toBe(true)
  })

  it("lists a reachable server's repos beside the desktop's, as the desktop's task page does", async () => {
    const client = desktop()
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    expect(model().repos).toEqual([...MAC_REPOS, VM_REPO])
    expect(await loadRepos(model)).toEqual([...MAC_REPOS, VM_REPO])
    expect(ranOn(client, 'repo.list').sort()).toEqual(['desktop', 'runtime:vm'])
  })

  it('loads the desktop list while a server never answers', async () => {
    const client = desktop(() => new Promise(() => {}))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    await settle()
    expect(ranOn(client, 'repo.list').sort()).toEqual(['desktop', 'runtime:vm'])
    expect(model().repos).toEqual(MAC_REPOS)
  })

  it("loads a server repo's GitHub items from that server, as the screen's list does", async () => {
    const client = desktop()
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    const earlier = ranOn(client, 'github.listWorkItems').length
    const page: { titles?: string[] } = {}
    await act(async () => {
      const loaded = await model().fetchGitHubItemsPage(model().client!, model().repos)
      page.titles = loaded.items.map((item) => item.title).sort()
    })
    expect(page.titles).toEqual(['from the desktop', 'from the server'])
    expect(ranOn(client, 'github.listWorkItems').slice(earlier).sort()).toEqual([
      'desktop',
      'runtime:vm'
    ])
  })

  it("names a server repo's host before its path in the repo pickers", async () => {
    const model = await mount(desktop(), [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await loadRepos(model)
    await settle()
    const details = model().repos.map((repo) => getTaskRepoDetail(repo, model().repoHostLabels))
    expect(details).toEqual(['This computer · /mac/app', 'VM · /srv/api'])
  })

  it('keeps the desktop list alone on a desktop that does not relay', async () => {
    const client = desktop()
    const model = await mount(client, [])
    await settle()
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    expect(ranOn(client, 'mobileRelay.hosts.list')).toEqual([])
    expect(ranOn(client, 'repo.list')).toEqual(['desktop'])
  })

  it("keeps the desktop's repos when a server fails to list its own", async () => {
    const model = await mount(
      desktop(async () => {
        throw new Error('server went away')
      }),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    )
    await settle()
    expect(await loadRepos(model)).toEqual(MAC_REPOS)
    expect(model().repos).toEqual(MAC_REPOS)
  })

  it("adds a late server's items without blanking the desktop's or showing the full spinner", async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    )
    await act(async () => {
      await model().loadTasks()
    })
    expect({ error: model().error, titles: model().items.map((item) => item.title) }).toEqual({
      error: '',
      titles: ['from the desktop']
    })
    const joinedFrom = renders.length
    const loadedBefore = ranOn(desktopRef.current!, 'github.listWorkItems').length
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect(ranOn(desktopRef.current!, 'github.listWorkItems').slice(loadedBefore).sort()).toEqual([
      'desktop',
      'runtime:vm'
    ])
    expect(
      model()
        .items.map((item) => item.title)
        .sort()
    ).toEqual(['from the desktop', 'from the server'])
    expect(renders.slice(joinedFrom).filter((seen) => seen.loading || seen.count === 0)).toEqual([])
  })

  it("re-lists nothing on a server's health or label change, and reloads nothing on an equal answer", async () => {
    let hosts = HOSTS
    const client = desktop(undefined, async () => ({ hosts }))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
    await act(async () => {
      await model().loadTasks()
    })
    await settle()
    const listed = ranOn(client, 'repo.list').length
    const loaded = ranOn(client, 'github.listWorkItems').length
    hosts = HOSTS.map((host) => ({
      ...host,
      label: `${host.label} (renamed)`,
      health: 'connecting'
    }))
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
    expect(ranOn(client, 'repo.list')).toHaveLength(listed)
    await act(async () => {
      await model().repoListReload()
    })
    await settle()
    expect(ranOn(client, 'repo.list').slice(listed)).toEqual(['desktop', 'runtime:vm'])
    expect(ranOn(client, 'github.listWorkItems')).toHaveLength(loaded)
  })

  it("lists all while a saved server repo's server is pending, then filters to it", async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      ['vm-repo']
    )
    await settle()
    expect([...model().effectiveRepoIds]).toEqual([])
    expect(titles(model)).toEqual(['from the desktop'])
    const before = ranOn(desktopRef.current!, 'github.listWorkItems').length
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    expect(titles(model)).toEqual(['from the server'])
    expect(ranOn(desktopRef.current!, 'github.listWorkItems').slice(before)).toEqual(['runtime:vm'])
  })

  it("keeps a server repo's filter through a one-poll drop-out and a reconnect", async () => {
    let hosts = HOSTS
    const client = desktop(undefined, async () => ({ hosts }))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY], ['vm-repo'])
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    hosts = HOSTS.map((host) => ({ ...host, relay: 'unavailable' }))
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
    expect(model().repos).toEqual(MAC_REPOS)
    hosts = HOSTS
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    await act(async () => {
      client.publishState('disconnected')
    })
    await act(async () => {
      client.publishState('connected')
    })
    await settle()
    expect([...model().selectedRepoIds]).toEqual(['vm-repo'])
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    expect(titles(model)).toEqual(['from the server'])
  })

  it('applies a desktop-only filter at once, and loads nothing more when a server joins', async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      ['mac-repo']
    )
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['mac-repo'])
    expect(titles(model)).toEqual(['from the desktop'])
    const before = ranOn(desktopRef.current!, 'github.listWorkItems').length
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect(model().repos).toEqual([...MAC_REPOS, VM_REPO])
    expect(ranOn(desktopRef.current!, 'github.listWorkItems')).toHaveLength(before)
  })

  it('lists all once the server behind the only selected repo is removed', async () => {
    let hosts = HOSTS
    const client = desktop(undefined, async () => ({ hosts }))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY], ['vm-repo'])
    await settle()
    expect(titles(model)).toEqual(['from the server'])
    const before = ranOn(client, 'github.listWorkItems').length
    const leftFrom = renders.length
    hosts = []
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
    expect([...model().effectiveRepoIds]).toEqual([])
    expect(titles(model)).toEqual(['from the desktop'])
    expect(ranOn(client, 'github.listWorkItems').slice(before)).toEqual(['desktop'])
    expect(renders.slice(leftFrom).some((seen) => seen.refreshing)).toBe(false)
  })

  it("edits the filter from what's shown, so a gone repo can't turn a tap into All", async () => {
    // Keep a third repo so selecting two still tests a filter rather than All.
    const vmDocs = { id: 'vm-docs', displayName: 'docs', path: '/srv/docs' }
    const model = await mount(
      desktop(async () => ({ repos: [...VM_REPOS, vmDocs] })),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      ['vm-repo', 'gone-repo']
    )
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    await act(async () => {
      model().toggleRepoSelection('mac-repo')
    })
    await settle()
    expect([...model().selectedRepoIds].sort()).toEqual(['mac-repo', 'vm-repo'])
    expect([...model().effectiveRepoIds].sort()).toEqual(['mac-repo', 'vm-repo'])
    const saved = sentBy
      .get(desktopRef.current!)!
      .filter((sent) => sent.method === 'settings.update')
      .map((sent) => sent.params)
    expect(saved).toHaveLength(1)
    const ids = saved.flatMap((params) =>
      params && typeof params === 'object' && 'defaultRepoSelection' in params
        ? params.defaultRepoSelection
        : []
    )
    expect(ids.sort()).toEqual(['mac-repo', 'vm-repo'])
  })

  it("doesn't reload an unfiltered Linear list when a server's repos join", async () => {
    const late = deferred<unknown>()
    const model = await mount(
      desktop(() => late.promise),
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      [],
      {
        visibleTaskProviders: ['github', 'linear'],
        defaultTaskSource: 'linear'
      }
    )
    await settle()
    const before = ranOn(desktopRef.current!, 'linear.listIssues').length
    expect(before).toBeGreaterThan(0)
    late.resolve({ repos: VM_REPOS })
    await settle()
    expect(model().repos).toEqual([...MAC_REPOS, VM_REPO])
    expect(ranOn(desktopRef.current!, 'linear.listIssues')).toHaveLength(before)
  })

  it('loads Linear once when a removed server widens the repo filter', async () => {
    let hosts = HOSTS
    const client = desktop(undefined, async () => ({ hosts }))
    const model = await mount(client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY], ['vm-repo'], {
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskSource: 'linear'
    })
    await settle()
    expect([...model().effectiveRepoIds]).toEqual(['vm-repo'])
    const before = ranOn(client, 'linear.listIssues').length
    expect(before).toBeGreaterThan(0)
    hosts = []
    await act(async () => {
      await relayHostsFeed(client).read()
    })
    await settle()
    expect([...model().effectiveRepoIds]).toEqual([])
    expect(ranOn(client, 'linear.listIssues').slice(before)).toEqual(['desktop'])
  })
})

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function titles(model: () => ConnectionPresentationModel): string[] {
  return model()
    .items.map((item) => item.title)
    .sort()
}
