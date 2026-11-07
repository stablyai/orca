// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  buildMobileProjectSectionCatalog,
  MOBILE_PROJECT_SECTIONS_METHOD
} from '../../../src/shared/mobile-project-sections-contract'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { setCachedRepos } from '../cache/repo-cache'
import type { RpcResponse } from '../transport/types'
import { useNewWorkspaceRepositories } from './use-new-workspace-repositories'
import { useNewWorkspaceRuntimeContext } from './use-new-workspace-runtime-context'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions
} from './new-workspace-project-targets'

vi.mock('../worktree/use-last-visited-worktree-repo', () => ({
  useLastVisitedWorktreeRepoId: () => ({ loaded: true, repoId: null })
}))

let root: Root | undefined
let container: HTMLDivElement
let latest: ReturnType<typeof useNewWorkspaceRepositories>
let executionSettings: ReturnType<typeof useNewWorkspaceRuntimeContext>['runtimeSettings']
let options: ReturnType<typeof buildNewWorkspaceProjectOptions> = []
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('holds grouping until delayed owner input and keeps owner groups across A → B → A execution settings', async () => {
  const base = {
    id: 'a',
    displayName: 'app',
    path: '/app/a',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }
  const repos = [base, { ...base, id: 'b', path: '/app/b' }]
  const serverRepo = {
    ...base,
    id: 'c',
    path: '/server/app',
    executionHostId: 'runtime:server' as const
  }
  const all = [...repos, serverRepo]
  const projection = projectHostSetupProjectionFromRepos(all)
  const catalog = buildMobileProjectSectionCatalog(all, projection, 'manual', undefined, {
    projectGroupingMode: 'repository'
  })
  let resolveCatalog: (value: RpcResponse) => void = () => {}
  const pending = new Promise<RpcResponse>((resolve) => {
    resolveCatalog = resolve
  })
  const desktop = new FakeSession('connected')
  desktop.sendRequest.mockImplementation(async (method) => {
    if (method === MOBILE_PROJECT_SECTIONS_METHOD) {
      return pending
    }
    if (method === 'repo.list') {
      return reply({ repos })
    }
    if (method === 'settings.get') {
      return reply({ settings: { defaultTuiAgent: 'codex' } })
    }
    return reply({})
  })
  const server = new FakeSession('connected')
  server.sendRequest.mockImplementation(async (method) => {
    if (method === 'repo.list') {
      return reply({ repos: [serverRepo] })
    }
    if (method === 'settings.get') {
      return reply({ settings: { defaultTuiAgent: 'claude' } })
    }
    return reply({})
  })
  const servers: ReadonlyMap<ExecutionHostId, FakeSession> = new Map([['runtime:server', server]])
  setCachedRepos('group-owner', repos)
  function Harness() {
    latest = useNewWorkspaceRepositories({
      client: desktop,
      serverClients: servers,
      hostId: 'group-owner',
      visible: true
    })
    const onServer = latest.selectedRepo?.executionHostId === 'runtime:server'
    const runtime = useNewWorkspaceRuntimeContext(
      onServer ? server : desktop,
      true,
      'group-owner',
      onServer ? 'runtime:server' : undefined
    )
    executionSettings = runtime.runtimeSettings
    options = latest.grouping
      ? buildNewWorkspaceProjectOptions(latest.repos, undefined, latest.grouping)
      : []
    return <output>{latest.grouping ? 'known' : 'pending'}</output>
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Harness />))
  expect(container.textContent).toBe('pending')
  expect(options).toHaveLength(0)
  await act(async () => resolveCatalog(reply({ catalog })))
  expect(container.textContent).toBe('known')
  expect(options).toHaveLength(1)
  const key = options[0].id
  expect(
    buildNewWorkspaceRunTargetOptions(
      latest.repos,
      key,
      null,
      undefined,
      undefined,
      latest.grouping!
    )
  ).toHaveLength(3)
  expect(executionSettings?.defaultTuiAgent).toBe('codex')
  await act(async () => latest.setSelectedRepo(serverRepo))
  expect(executionSettings?.defaultTuiAgent).toBe('claude')
  expect(options.map((option) => option.id)).toEqual([key])
  await act(async () => latest.setSelectedRepo(base))
  expect(executionSettings?.defaultTuiAgent).toBe('codex')
  expect(options.map((option) => option.id)).toEqual([key])
  expect(
    desktop.sendRequest.mock.calls.filter(([method]) => method === MOBILE_PROJECT_SECTIONS_METHOD)
  ).toHaveLength(1)
})

it.each(['null', 'method_not_found'] as const)(
  'finishes owner loading for an old desktop response: %s',
  async (kind) => {
    const base = {
      id: 'legacy-a',
      displayName: 'App',
      path: '/app/a',
      upstream: { owner: 'org', repo: 'app' }
    }
    const repos = [base, { ...base, id: 'legacy-b', path: '/app/b' }]
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) => {
      if (method === MOBILE_PROJECT_SECTIONS_METHOD) {
        return kind === 'null'
          ? reply({ catalog: null })
          : {
              id: 'reply',
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' }
            }
      }
      return reply({ repos })
    })
    function Harness() {
      const state = useNewWorkspaceRepositories({ client, visible: true })
      return <output>{state.grouping?.groups.length ?? 'pending'}</output>
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Harness />))
    expect(container.textContent).toBe('2')
  }
)

vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }))
