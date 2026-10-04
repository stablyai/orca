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
  } = { loads: [], requests: [], gh: vi.fn(), apiUpdate: vi.fn(), preference: 'upstream' }
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
    { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
  )
}))
vi.mock('@/lib/repo-runtime-owner', () => ({
  getSettingsForRepoRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
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
import { findTaskPageDialogWorkItem } from '../../src/renderer/src/components/task-page-cache-selectors'
import { getTaskPageRepoSourceContext } from '../../src/renderer/src/components/task-page-source-context'
import { workItemsCacheKey } from '../../src/renderer/src/store/github/cache-identity'
import { createTestStore } from '../../src/renderer/src/store/slices/github-slice-test-harness'
import { getTaskSourceCacheScope } from '../../src/shared/task-source-context'
import { listLabels, listAssignableUsers } from '../../src/main/github/issue-field-options'
import { useRepoLabels, useRepoAssignees } from '../../src/renderer/src/hooks/useIssueMetadata'
import { updateIssue } from '../../src/main/github/issue-update'
import { materializeTaskPageItemList } from '../../src/renderer/src/components/task-page-github-work-item-mutations'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '../../src/renderer/src/components/task-page-github-work-item-mutation-registry'

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

type MetadataArgs = { repoPath: string; ownerRepo?: GitHubOwnerRepo }

beforeEach(() => {
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
      itemId: opened.id,
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
      patchWorkItem: store.getState().patchWorkItem,
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

it.each([
  { openedItem: fork, listItem: fork },
  { openedItem: fork, listItem: upstream },
  { openedItem: upstream, listItem: fork },
  { openedItem: upstream, listItem: upstream }
])(
  'a $openedItem.title close only controls its own row while search lags (list=$listItem.title)',
  async ({ openedItem, listItem }) => {
    const target = { ...issueRepo, owner: openedItem === fork ? 'fork-owner' : 'upstream-owner' }
    let pending = Promise.resolve()
    runGHEditStateChange({
      newState: 'closed',
      localState: 'open',
      itemId: fork.id,
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
      patchWorkItem: vi.fn(),
      patchProjectRowIfNeeded: vi.fn(),
      onMutated: vi.fn()
    })
    await pending
    expect(fixture.apiUpdate).toHaveBeenCalledWith(expect.objectContaining({ ownerRepo: target }))
    const displayed = materializeTaskPageItemList({
      networkItems: [listItem],
      previousItems: [listItem],
      queryKey: 'current-upstream-list'
    })
    expect(displayed[0]?.state).toBe(listItem.url === openedItem.url ? 'closed' : 'open')
  }
)

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
  const key = workItemsCacheKey(registeredRepo.id, 36, '', getTaskSourceCacheScope(sourceContext))
  store.setState({ workItemsCache: { [key]: { data: [upstream, fork], fetchedAt: 1 } } })
  fixture.gh.mockRejectedValueOnce(new Error('Fixture rejects label'))
  let pending = Promise.resolve(false)
  const observed: string[][][] = []
  runGHEditLabelToggle({
    itemId: fork.id,
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
    patchWorkItem: store.getState().patchWorkItem,
    patchProjectRowIfNeeded: vi.fn(),
    onMutated: vi.fn()
  })
  expect(await pending).toBe(false)
  expect(observed).toEqual([
    [[], ['fork-only-label']],
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
