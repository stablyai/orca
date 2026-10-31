import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import type * as GhUtils from '../../src/main/github/gh-utils'
import type * as IssueMetadata from '../../src/renderer/src/hooks/useIssueMetadata'
import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../src/shared/github/pull-request-types'
import type { TaskSourceContext } from '../../src/shared/task-source-context'
import type { Repo } from '../../src/shared/repo-types'

const fixture = vi.hoisted(() => {
  const state: {
    loads: { key: string | null; load: () => Promise<unknown[]> }[]
    requests: { args: string[]; host?: string }[]
    gh: ReturnType<typeof vi.fn>
    apiUpdate: ReturnType<typeof vi.fn>
    preference: 'origin' | 'upstream'
    store: ReturnType<typeof createTestStore> | null
  } = {
    loads: [],
    requests: [],
    gh: vi.fn(),
    apiUpdate: vi.fn(),
    preference: 'upstream',
    store: null
  }
  return state
})

vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useMemo: <T>(value: () => T) => value(),
  useCallback: <T>(value: T) => value,
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: vi.fn()
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(value: T) => value }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ patchWorkItem: vi.fn(), patchProjectRowContent: vi.fn() }),
    // Edits reach Tasks copies through the store the case created.
    { getState: () => fixture.store?.getState() ?? { recordFeatureInteraction: vi.fn() } }
  )
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock('@/components/github/github-work-item-comment-mutations', () => ({
  notifyWorkItemDetailsMutation: vi.fn()
}))
vi.mock('@/hooks/useIssueMetadata', async (original) => ({
  ...(await original<typeof IssueMetadata>()),
  useImmediateMutation: () => ({ isPending: () => false, run: vi.fn() })
}))
vi.mock('@/hooks/useMetadataListRequest', () => ({
  useMetadataListRequest: <T>(args: { cacheKey: string | null; load: () => Promise<T[]> }) => {
    fixture.loads.push({ key: args.cacheKey, load: args.load })
    return { data: [], loading: false, error: null }
  }
}))
vi.mock('../../src/main/github/gh-utils', async (original) => ({
  ...(await original<typeof GhUtils>()),
  ghExecFileAsync: fixture.gh,
  acquire: vi.fn(),
  release: vi.fn(),
  getOwnerRepoForRemote: async (_path: string, remote: string) => ({
    owner: remote === 'upstream' ? 'upstream-owner' : 'fork-owner',
    repo: 'widgets'
  })
}))
vi.mock('../../src/main/git/remote-name-listing', () => ({
  shouldProbeGitRemote: async () => true
}))

import { GHEditSection } from '../../src/renderer/src/components/github-item-dialog/edit-item-fields/gh-edit-section'
import {
  runGHEditLabelToggle,
  runGHEditStateChange
} from '../../src/renderer/src/components/github-item-dialog/edit-item-fields/gh-edit-section-mutations'
import { findTaskPageDialogWorkItem } from '../../src/renderer/src/components/task-page/task-page-cache-selectors'
import { getTaskPageRepoSourceContext } from '../../src/renderer/src/components/task-page/task-page-source-context'
import { workItemsCacheKey } from '../../src/renderer/src/store/github/cache-identity'
import { createTestStore } from '../../src/renderer/src/store/slices/github-slice-test-harness'
import {
  materializeTaskPageItemList,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '../../src/renderer/src/components/task-page/github/task-page-github-work-item-mutation-pages'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '../../src/renderer/src/store/slices/runtime-status-connection-generation'
import { getLastConfirmedClientValue } from '../../src/renderer/src/components/task-page/github/task-page-github-confirmed-client-values'
import { RuntimeRpcCallError } from '../../src/renderer/src/runtime/runtime-rpc-result'
import { getTaskSourceCacheScope } from '../../src/shared/task-source-context'
import { listLabels, listAssignableUsers } from '../../src/main/github/issue-field-options'
import { useRepoLabels, useRepoAssignees } from '../../src/renderer/src/hooks/useIssueMetadata'
import { updateIssue } from '../../src/main/github/issue-update'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '../../src/renderer/src/components/task-page/github/task-page-github-work-item-mutation-registry'

function renderEditSection(props: Parameters<typeof GHEditSection>[0]): void {
  renderToStaticMarkup(createElement(GHEditSection, props))
}

const registeredRepo: Repo = {
  id: 'repo-1',
  path: join(tmpdir(), 'orca-opened-issue-repository-fixture'),
  displayName: 'widgets',
  badgeColor: 'primary',
  addedAt: 1,
  upstream: { owner: 'upstream-owner', repo: 'widgets', host: 'github.com' }
}

function sourceFor(preference: 'origin' | 'upstream'): TaskSourceContext {
  const source = getTaskPageRepoSourceContext(
    { ...registeredRepo, issueSourcePreference: preference },
    'github'
  )
  if (!source) {
    throw new Error('Registered fixture must produce a source context')
  }
  return source
}

const sourceContext = sourceFor('origin')
const fork: GitHubWorkItem = {
  id: 'issue:5',
  type: 'issue',
  number: 5,
  title: 'FORK title',
  state: 'open',
  url: 'https://github.com/fork-owner/widgets/issues/5',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'repo-1'
}
const upstream: GitHubWorkItem = {
  ...fork,
  title: 'UPSTREAM title',
  url: 'https://github.com/upstream-owner/widgets/issues/5'
}
const issueRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
const unsupported = () =>
  new RuntimeRpcCallError({
    id: 'old-server',
    ok: false,
    error: { code: 'method_not_found', message: 'unsupported' }
  })

type MetadataArgs = { repoPath: string; ownerRepo?: GitHubOwnerRepo }

beforeEach(() => {
  fixture.store = null
  fixture.preference = 'upstream'
  fixture.loads = []
  fixture.requests = []
  resetTaskPageGitHubMutationRegistryForTests()
  setTaskPageGitHubMutationQueryKey('current-upstream-list')
  fixture.gh.mockReset()
  fixture.gh.mockImplementation(async (args: string[], options: { host?: string }) => {
    fixture.requests.push({ args, host: options.host })
    return { stdout: '', stderr: '' }
  })
  fixture.apiUpdate = vi.fn((args: Parameters<typeof window.api.gh.updateIssue>[0]) =>
    updateIssue(
      args.repoPath,
      args.number,
      args.updates,
      null,
      {},
      fixture.preference,
      args.ownerRepo
    )
  )
  vi.stubGlobal('window', {
    api: {
      gh: {
        updateIssue: fixture.apiUpdate,
        listLabels: (args: MetadataArgs) =>
          listLabels(args.repoPath, fixture.preference, null, {}, args.ownerRepo),
        listAssignableUsers: (args: MetadataArgs) =>
          listAssignableUsers(args.repoPath, fixture.preference, null, {}, args.ownerRepo)
      }
    }
  })
})

afterEach(() => {
  resetTaskPageGitHubMutationRegistryForTests()
  vi.unstubAllGlobals()
})

it.each([
  { openedItem: fork, listItem: upstream, preference: 'upstream' },
  { openedItem: upstream, listItem: fork, preference: 'origin' },
  { openedItem: fork, listItem: fork, preference: 'origin' }
] as const)(
  'scopes $openedItem.title labels under $preference to its canonical list row',
  async ({ openedItem, listItem, preference }) => {
    fixture.preference = preference
    expect(sourceFor('upstream')).toEqual(sourceContext)
    const store = createTestStore()
    store.setState({ repos: [], recordFeatureInteraction: vi.fn() })
    fixture.store = store
    const key = workItemsCacheKey(
      registeredRepo.id,
      36,
      '',
      getTaskSourceCacheScope(sourceFor('upstream'))
    )
    store.setState({
      workItemsCache: { [key]: { data: [listItem], fetchedAt: Date.now() } }
    })
    const opened =
      findTaskPageDialogWorkItem(store.getState().workItemsCache, {
        id: openedItem.id,
        repoId: openedItem.repoId,
        url: openedItem.url
      }) ?? openedItem
    expect(opened.url).toBe(openedItem.url)
    const target = { ...issueRepo, owner: openedItem === fork ? 'fork-owner' : 'upstream-owner' }
    let mutation: Promise<unknown> = Promise.resolve()
    runGHEditLabelToggle({
      item: opened,
      itemNumber: opened.number,
      itemRepoId: opened.repoId,
      repoPath: registeredRepo.path,
      sourceContext,
      projectOrigin: undefined,
      issueRepo: target,
      label: 'fork-only-label',
      localLabels: [],
      run: async (_key, options) => {
        options.onOptimistic?.()
        mutation = options.mutate()
        await mutation
        options.onSuccess?.()
        return true
      },
      onLabelsChange: vi.fn(),
      patchProjectRowIfNeeded: vi.fn(),
      onMutated: vi.fn()
    })
    await mutation
    expect(fixture.requests[0].args).toContain(`${target.owner}/widgets`)
    expect(fixture.apiUpdate).toHaveBeenCalledWith(expect.objectContaining({ ownerRepo: target }))
    expect(store.getState().workItemsCache[key]?.data?.[0].labels).toEqual(
      listItem.url === openedItem.url ? ['fork-only-label'] : []
    )
  }
)

it.each([
  { openedItem: fork, owner: 'fork-owner', preference: 'origin' },
  { openedItem: fork, owner: 'fork-owner', preference: 'upstream' },
  { openedItem: upstream, owner: 'upstream-owner', preference: 'origin' },
  { openedItem: upstream, owner: 'upstream-owner', preference: 'upstream' }
] as const)(
  'loads $owner picker candidates while preference=$preference',
  async ({ preference, openedItem, owner }) => {
    fixture.preference = preference
    renderEditSection({
      item: openedItem,
      repoPath: registeredRepo.path,
      repoId: fork.repoId,
      sourceContext,
      projectOrigin: undefined,
      localState: 'open',
      localLabels: [],
      assignees: [],
      onStateChange: vi.fn(),
      onLabelsChange: vi.fn(),
      onMutated: vi.fn(),
      onUse: vi.fn()
    })
    for (const request of fixture.loads.filter((load) => load.key !== null)) {
      await request.load()
    }
    expect(
      fixture.requests.map((request) => request.args.find((arg) => arg.startsWith('repos/')))
    ).toEqual([`repos/${owner}/widgets/labels`, `repos/${owner}/widgets/assignees?per_page=100`])
  }
)

it.each(
  [true, false].flatMap((tracked) => [
    { openedItem: fork, listItem: fork, tracked },
    { openedItem: fork, listItem: upstream, tracked },
    { openedItem: upstream, listItem: fork, tracked },
    { openedItem: upstream, listItem: upstream, tracked }
  ])
)(
  'a $openedItem.title close only controls its own row while search lags (list=$listItem.title, tracked=$tracked)',
  async ({ openedItem, listItem, tracked }) => {
    const target = { ...issueRepo, owner: openedItem === fork ? 'fork-owner' : 'upstream-owner' }
    fixture.store = createTestStore()
    fixture.store.setState({ repos: [registeredRepo], recordFeatureInteraction: vi.fn() })
    const cache = fixture.store.getState().githubTaskCache
    const binding = cache.capture(registeredRepo, sourceContext)!
    if (!tracked) {
      // An old server without the item route: no task record can own the edit, so main's hold applies.
      await cache.readCanonical(openedItem, binding, () => Promise.reject(unsupported()))
      expect(cache.canTrack(binding)).toBe(false)
    }
    let pending = Promise.resolve()
    runGHEditStateChange({
      newState: 'closed',
      localState: 'open',
      item: openedItem,
      itemNumber: fork.number,
      itemRepoId: fork.repoId,
      repoPath: registeredRepo.path,
      sourceContext,
      projectOrigin: undefined,
      issueRepo: target,
      run: (_key, options) => {
        pending = (async () => {
          options.onOptimistic?.()
          await options.mutate()
          options.onSuccess?.()
        })()
        return pending
      },
      onStateChange: vi.fn(),
      patchProjectRowIfNeeded: vi.fn(),
      onMutated: vi.fn()
    })
    await pending
    expect(fixture.apiUpdate).toHaveBeenCalledWith(expect.objectContaining({ ownerRepo: target }))
    // A record owns a tracked close; only an untracked one keeps main's registry hold.
    const hold = getLastConfirmedClientValue(
      getTaskSourceCacheScope(sourceContext),
      fork.repoId,
      fork.id,
      'state'
    )
    expect(hold).toBe(tracked ? undefined : 'closed')
    // The lagging search row goes through the fetch, the Tasks page list and its projection.
    const [shown] = materializeTaskPageItemList({
      networkItems: [...cache.acceptSearch([listItem], binding)],
      previousItems: [listItem],
      queryKey: 'current-upstream-list'
    })
    expect(cache.projectItem(shown).state).toBe(listItem.url === openedItem.url ? 'closed' : 'open')
  }
)

it.each(
  [true, false].flatMap(
    (tracked) =>
      [
        { tracked, from: 'open', to: 'closed' },
        { tracked, from: 'closed', to: 'open' }
      ] as const
  )
)(
  'a failed $to edit leaves stored copies as they were through a refresh (tracked=$tracked)',
  async ({ tracked, from, to }) => {
    const store = createTestStore()
    store.setState({ repos: [registeredRepo], recordFeatureInteraction: vi.fn() })
    fixture.store = store
    const cache = store.getState().githubTaskCache
    const binding = cache.capture(registeredRepo, sourceContext)!
    if (!tracked) {
      await cache.readCanonical(fork, binding, () => Promise.reject(unsupported()))
    }
    const row = { ...fork, state: from }
    const key = workItemsCacheKey(registeredRepo.id, 36, '', getTaskSourceCacheScope(sourceContext))
    store.setState({ workItemsCache: { [key]: { data: [row], fetchedAt: 1 } } })
    fixture.apiUpdate.mockRejectedValueOnce(new Error('denied'))
    let pending = Promise.resolve()
    let pages = [row]
    runGHEditStateChange({
      newState: to,
      localState: from,
      item: row,
      itemNumber: fork.number,
      itemRepoId: fork.repoId,
      repoPath: registeredRepo.path,
      sourceContext,
      projectOrigin: undefined,
      issueRepo,
      run: (_key, options) => {
        pending = (async () => {
          options.onOptimistic?.()
          // A Tasks refresh lands while the edit is in flight, with search still lagging.
          reapplyPendingTaskPageGitHubMutationsToCache({
            items: store.getState().workItemsCache[key]?.data ?? [],
            patchWorkItem: store.getState().patchWorkItem,
            sourceContextByRepoId: new Map([[registeredRepo.id, sourceContext]])
          })
          pages = materializeTaskPageItemList({
            networkItems: [row],
            previousItems: pages,
            queryKey: 'current-upstream-list'
          })
          await options.mutate().catch(() => options.onRevert?.())
        })()
        return pending
      },
      onStateChange: vi.fn(),
      patchProjectRowIfNeeded: vi.fn(),
      onMutated: vi.fn()
    })
    await pending
    const raw = store.getState().workItemsCache[key]!.data![0]
    const shown = [raw, pages[0]].map((copy) => cache.projectItem(copy).state)
    expect([raw.state, pages[0].state, ...shown]).toEqual([from, from, from, from])
    expect(
      getLastConfirmedClientValue(
        getTaskSourceCacheScope(sourceContext),
        fork.repoId,
        fork.id,
        'state'
      )
    ).toBeUndefined()
  }
)

it('lets a record own a close that began on an unsupported server and succeeded after a reconnect', async () => {
  setRuntimeEnvironmentConnectionGenerationForTests('p34245-takeover', 1)
  const remote = { ...registeredRepo, executionHostId: 'runtime:p34245-takeover' }
  const remoteSource = getTaskPageRepoSourceContext(remote, 'github')!
  const store = createTestStore()
  store.setState({
    repos: [remote],
    runtimeStatusByEnvironmentId: new Map(),
    recordFeatureInteraction: vi.fn()
  })
  fixture.store = store
  const cache = store.getState().githubTaskCache
  await cache.readCanonical(fork, cache.capture(remote, remoteSource)!, () =>
    Promise.reject(unsupported())
  )
  expect(cache.canTrack(cache.capture(remote, remoteSource)!)).toBe(false)
  runGHEditStateChange({
    newState: 'closed',
    localState: 'open',
    item: fork,
    itemNumber: fork.number,
    itemRepoId: fork.repoId,
    repoPath: remote.path,
    sourceContext: remoteSource,
    projectOrigin: undefined,
    issueRepo,
    // The write is in flight while the upgraded server reconnects, then it succeeds.
    run: async (_key, options) => {
      options.onOptimistic?.()
      setRuntimeEnvironmentConnectionGenerationForTests('p34245-takeover', 2)
      store.setState({ runtimeStatusByEnvironmentId: new Map() })
      options.onSuccess?.()
    },
    onStateChange: vi.fn(),
    patchProjectRowIfNeeded: vi.fn(),
    onMutated: vi.fn()
  })
  const scope = getTaskSourceCacheScope(remoteSource)
  expect(getLastConfirmedClientValue(scope, fork.repoId, fork.id, 'state')).toBeUndefined()
  const binding = cache.capture(remote, remoteSource)!
  expect(cache.isPending(fork, binding) || cache.readRevision(fork, binding) > 0).toBe(true)
  expect(cache.projectItem(cache.acceptSearch([fork], binding)[0]).state).toBe('closed')
})

it('sends a duplicate close with its reason even when the issue already reads closed', async () => {
  fixture.store = createTestStore()
  fixture.store.setState({ repos: [], recordFeatureInteraction: vi.fn() })
  let pending: Promise<void> = Promise.resolve()
  runGHEditStateChange({
    newState: 'closed',
    closeAction: { stateReason: 'duplicate', duplicateOf: 42 },
    localState: 'closed',
    item: { ...fork, state: 'closed' },
    itemNumber: fork.number,
    itemRepoId: fork.repoId,
    repoPath: registeredRepo.path,
    sourceContext,
    projectOrigin: undefined,
    issueRepo,
    run: (_key, options) => {
      pending = options.mutate().then(() => options.onSuccess?.())
      return pending
    },
    onStateChange: vi.fn(),
    patchProjectRowIfNeeded: vi.fn(),
    onMutated: vi.fn()
  })
  await pending
  expect(fixture.apiUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      updates: expect.objectContaining({ stateReason: 'duplicate', duplicateOf: 42 })
    })
  )
  // The hold covers only the confirmed state, never the duplicate metadata.
  expect(
    getLastConfirmedClientValue(
      getTaskSourceCacheScope(sourceContext),
      fork.repoId,
      fork.id,
      'state'
    )
  ).toBe('closed')
})

it('keeps ordinary metadata caches distinct by canonical repository and host', () => {
  const identities = [
    issueRepo,
    { ...issueRepo, owner: 'upstream-owner' },
    { ...issueRepo, host: 'ghe.example:8443' }
  ]
  for (const ownerRepo of identities) {
    useRepoLabels(registeredRepo.path, registeredRepo.id, { ownerRepo })
    useRepoAssignees(registeredRepo.path, registeredRepo.id, { ownerRepo })
  }
  expect(new Set(fixture.loads.filter((_, i) => i % 2 === 0).map((load) => load.key)).size).toBe(3)
  expect(new Set(fixture.loads.filter((_, i) => i % 2 === 1).map((load) => load.key)).size).toBe(3)
})

it('keeps metadata requests without an explicit target compatible', async () => {
  useRepoLabels(registeredRepo.path, registeredRepo.id)
  useRepoAssignees(registeredRepo.path, registeredRepo.id)
  for (const request of fixture.loads) {
    await request.load()
  }
  expect(fixture.loads.map((load) => load.key)).toEqual([registeredRepo.id, registeredRepo.id])
  expect(
    fixture.requests.map((request) => request.args.find((arg) => arg.startsWith('repos/')))
  ).toEqual([
    'repos/upstream-owner/widgets/labels',
    'repos/upstream-owner/widgets/assignees?per_page=100'
  ])
})

it('keeps Project row metadata on the existing slug route', async () => {
  const labels = vi.fn().mockResolvedValue({ ok: true, labels: [] })
  const users = vi.fn().mockResolvedValue({ ok: true, users: [] })
  vi.stubGlobal('window', {
    api: { gh: { listLabelsBySlug: labels, listAssignableUsersBySlug: users } }
  })
  renderEditSection({
    item: fork,
    repoPath: registeredRepo.path,
    repoId: fork.repoId,
    sourceContext,
    projectOrigin: {
      owner: 'project-owner',
      repo: 'outside',
      host: 'ghe.example',
      number: fork.number,
      type: 'issue',
      projectId: 'project-1',
      projectItemId: 'row-1',
      cacheKey: 'project-key'
    },
    localState: 'open',
    localLabels: [],
    assignees: [],
    onStateChange: vi.fn(),
    onLabelsChange: vi.fn(),
    onMutated: vi.fn(),
    onUse: vi.fn()
  })
  for (const request of fixture.loads.filter((load) => load.key !== null)) {
    await request.load()
  }
  expect(labels).toHaveBeenCalledWith({
    owner: 'project-owner',
    repo: 'outside',
    host: 'ghe.example'
  })
  expect(users).toHaveBeenCalledWith({
    owner: 'project-owner',
    repo: 'outside',
    host: 'ghe.example'
  })
  expect(fixture.requests).toEqual([])
})

it('rolls back a rejected fork label without changing the upstream row', async () => {
  const store = createTestStore()
  store.setState({ repos: [], recordFeatureInteraction: vi.fn() })
  fixture.store = store
  const key = workItemsCacheKey(registeredRepo.id, 36, '', getTaskSourceCacheScope(sourceContext))
  store.setState({ workItemsCache: { [key]: { data: [upstream, fork], fetchedAt: 1 } } })
  fixture.gh.mockRejectedValueOnce(new Error('Fixture rejects label'))
  let pending = Promise.resolve(false)
  const observed: string[][][] = []
  runGHEditLabelToggle({
    item: fork,
    itemNumber: fork.number,
    itemRepoId: fork.repoId,
    repoPath: registeredRepo.path,
    sourceContext,
    projectOrigin: undefined,
    issueRepo,
    label: 'fork-only-label',
    localLabels: [],
    run: (_key, options) => {
      pending = (async () => {
        options.onOptimistic?.()
        observed.push(store.getState().workItemsCache[key]?.data?.map((row) => row.labels) ?? [])
        try {
          await options.mutate()
          return true
        } catch {
          options.onRevert?.()
          observed.push(store.getState().workItemsCache[key]?.data?.map((row) => row.labels) ?? [])
          return false
        }
      })()
      return pending
    },
    onLabelsChange: vi.fn(),
    patchProjectRowIfNeeded: vi.fn(),
    onMutated: vi.fn()
  })
  expect(await pending).toBe(false)
  // Without a task record, Tasks copies take only a confirmed change; the dialog keeps its own optimism.
  expect(observed).toEqual([
    [[], []],
    [[], []]
  ])
})

it('does not fall back to upstream metadata for an invalid explicit repository', async () => {
  const invalid = { owner: '../escape', repo: 'widgets', host: 'github.com' }
  await expect(listLabels(registeredRepo.path, 'upstream', null, {}, invalid)).resolves.toEqual([])
  await expect(
    listAssignableUsers(registeredRepo.path, 'upstream', null, {}, invalid)
  ).resolves.toEqual([])
  expect(fixture.requests).toEqual([])
})
