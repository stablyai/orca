import { useMobileTasksLinearItemActions } from './use-mobile-tasks-linear-item-actions'
import { useMobileTasksGithubReplyMergeActions } from './use-mobile-tasks-github-reply-merge-actions'
import { useMobileTasksGitlabGithubStatusActions } from './use-mobile-tasks-gitlab-github-status-actions'
import { useMobileTasksItemDetailMetadataEffects } from './use-mobile-tasks-item-detail-metadata-effects'
import { useMobileTasksProjectDetailLoading } from './use-mobile-tasks-project-detail-loading'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'
import { useMobileTasksItemState } from './use-mobile-tasks-item-state'
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'
import { useMobileTasksMutation } from './use-mobile-tasks-workspace-and-project-state'
import { useMobileTasksItemSelectionEffects } from './use-mobile-tasks-list-and-detail-effects'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { useMobileTasksHostedCommentReviewActions } from './use-mobile-tasks-hosted-comment-review-actions'
import React, { useState, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import type { DetailPayload, GitHubDetailFile } from './mobile-tasks-provider-detail-types'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { item, projectRow } from './github-task-identity.test-fixture'
import { githubTaskKey, useMobileTasksSelection } from './github-task-identity'
import { useMobileTasksGithubCheckFileActions } from './use-mobile-tasks-github-check-file-actions'
import {
  useMobileTasksProjectFileMergeActions,
  type ProjectFileMergeActionsInput
} from './use-mobile-tasks-project-file-merge-actions'
import { useMobileTasksHostedMetadataActions } from './use-mobile-tasks-hosted-metadata-actions'
import { useCommittedOwnerProjection } from '../test-support/rpc-recording/task-action-mount-owners'
import { captureValue, type RecordedValue } from '../test-support/rpc-recording/recording-values'

vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  ...(await import('./mobile-tasks-project-fields')),
  ...(await import('./mobile-tasks-item-comments')),
  splitReviewerList: () => [],
  groupDetailComments: () => []
}))
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('react')),
  colors: {},
  isHostedTaskRepo: (repo: { kind?: string }) => repo.kind !== 'folder'
}))
const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount())
  }
})
const file: GitHubDetailFile = {
  path: 'same.ts',
  additions: 1,
  deletions: 0,
  status: 'modified',
  viewerViewedState: 'UNVIEWED'
}
function details(
  selected: Extract<TaskItem, { provider: 'github' }>
): Extract<DetailPayload, { provider: 'github' }> {
  return {
    provider: 'github',
    targetKey: githubTaskKey(selected.source),
    body: selected.title,
    labels: [],
    assignees: [],
    comments: [],
    reviewRequests: [],
    latestReviews: [],
    files: [file],
    checks: [],
    pullRequestId: `PR_${selected.title}`,
    headSha: `${selected.title}-head`,
    baseSha: `${selected.title}-base`
  }
}
async function mount() {
  const client = createFakeRpcClient()
  const logical = createStableLogicalRpcClient(client, 'relay')
  const a = item('fork')
  const b = item('upstream')
  const providerPages = vi.fn(async () => ({
    items: [a, b],
    sourcesByRepoId: {},
    sourceErrors: [],
    sourceFallbacks: [],
    failedCount: 0
  }))
  const repos = [{ id: 'clone', path: '/clone', displayName: 'clone' }]
  const repoListEnsureLoaded = async () => repos
  const effectiveRepoIds = new Set<string>()
  const noop = () => {}
  const committed: { name: string; value: RecordedValue }[] = []
  let current!: ReturnType<typeof ProbeModel>
  let select!: (selected: Extract<TaskItem, { provider: 'github' }> | null) => void
  let selectProject!: (selected: GitHubProjectRow | null) => void
  function ProbeModel() {
    const itemState = useMobileTasksItemState()
    const selection = useMobileTasksSelection(logical, itemState.detailPayload)
    const mutation = useMobileTasksMutation()
    const [items, setItems] = useState<TaskItem[]>([a, b])
    const [error, setError] = useState('')
    const [appliedQuery, setAppliedQuery] = useState('')
    const [refreshing, setRefreshing] = useState(false)
    const [loading, setLoading] = useState(false)
    const clientRef = useRef(logical)
    const loadGenerationRef = useRef(0)
    const listInput = {
      appliedQuery,
      client: logical,
      clientRef,
      connState: 'connected',
      countGitHubItemPages: noop,
      fetchGitHubItemsPage: providerPages,
      githubMode: 'items',
      gitlabFilter: 'opened',
      gitlabView: 'issues',
      linearConnected: false,
      jiraConnection: null,
      jiraFilter: 'assigned',
      linearFilter: 'all',
      linearOrderBy: 'updated',
      loadGenerationRef,
      provider: 'github',
      repoListEnsureLoaded,
      resetGitHubItemsState: noop,
      selectedLinearTeamIds: effectiveRepoIds,
      selectedLinearWorkspaceId: null,
      effectiveRepoIds,
      serverRepoList: repos,
      setError,
      setGithubCurrentPage: noop,
      setGithubPages: noop,
      setGithubRepoSources: noop,
      setGithubSourceErrors: noop,
      setGithubSourceFallbacks: noop,
      setGithubCountedTotalPages: noop,
      setItems,
      setLoading,
      setRefreshing,
      taskStateHydrated: true,
      tasksSupported: true
    }
    const listOwner = useMobileTasksTaskListLoading(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every member the production list owner reads; inactive provider branches are not entered.
      listInput as unknown as Parameters<typeof useMobileTasksTaskListLoading>[0]
    )
    const [linearCommentDraft, setLinearCommentDraft] = useState('linear comment')
    const [linearSubIssueTitle, setLinearSubIssueTitle] = useState('linear child')
    const [projectRowItem, setProjectRowItem] = useState<GitHubProjectRow | null>(null)
    const [projectRowDetail, setProjectRowDetail] = useState<DetailPayload | null>(null)
    const [projectRowDetailError, setProjectRowDetailError] = useState('')
    selectProject = (selected) => {
      selection.setActionItem(null)
      setProjectRowItem(selected)
    }
    select = (selected) => {
      setProjectRowItem(null)
      selection.setActionItem(selected)
      itemState.setDetailPayload(selected ? details(selected) : null)
    }
    useMobileTasksItemSelectionEffects({
      ...itemState,
      ...selection,
      client: logical,
      connState: 'connected'
    })
    const project: Pick<
      ProjectFileMergeActionsInput,
      | 'activeGitHubProjectHost'
      | 'findProjectRowRepo'
      | 'projectMutating'
      | 'projectRowDetail'
      | 'setGithubProjectTable'
      | 'setProjectMutating'
      | 'setProjectRowDetail'
      | 'setProjectRowDetailError'
      | 'setProjectRowItem'
    > = {
      activeGitHubProjectHost: 'github.corp',
      findProjectRowRepo: () => ({ id: 'clone', path: '/clone', displayName: 'clone' }),
      projectMutating: false,
      projectRowDetail,
      setGithubProjectTable: () => {},
      setProjectMutating: () => {},
      setProjectRowDetail,
      setProjectRowDetailError,
      setProjectRowItem
    }
    useMobileTasksProjectDetailLoading({
      ...project,
      ...itemState,
      client: logical,
      tasksSupported: true,
      githubProjectTable: null,
      projectRowDetailRefreshSeq: 0,
      projectRowItem,
      setProjectTitleDraft: () => {},
      setProjectBodyDraft: () => {},
      setProjectCommentDraft: () => {},
      setProjectEditingCommentId: () => {},
      setProjectEditingCommentDraft: () => {},
      setProjectReviewersDraft: () => {},
      setProjectFieldDrafts: () => {},
      setProjectRowDetailLoading: () => {}
    })
    useMobileTasksItemDetailMetadataEffects({
      ...itemState,
      ...selection,
      client: logical,
      tasksSupported: true
    })
    const model = {
      ...project,
      ...itemState,
      ...selection,
      ...mutation,
      client: logical,
      items,
      setItems,
      error,
      setError,
      projectRowDetailError,
      taskUiReady: true,
      linearCommentDraft,
      setLinearCommentDraft,
      linearSubIssueTitle,
      setLinearSubIssueTitle,
      loadTasks: listOwner.loadTasks,
      captureTaskListRefresh: listOwner.captureTaskListRefresh,
      setAppliedQuery,
      refreshing,
      loading
    }
    useCommittedOwnerProjection(
      {
        client: logical,
        effect: (name, value) => committed.push({ name, value: captureValue(value) })
      },
      { ...itemState, ...selection, ...mutation }
    )
    return useMobileTasksLinearItemActions(
      useMobileTasksGithubReplyMergeActions(
        useMobileTasksGithubCheckFileActions(
          useMobileTasksHostedCommentReviewActions(
            useMobileTasksHostedMetadataActions(
              useMobileTasksGitlabGithubStatusActions(useMobileTasksProjectFileMergeActions(model))
            )
          )
        )
      )
    )
  }

  function Probe() {
    current = ProbeModel()
    return React.createElement(
      'TaskDetail',
      {
        title: current.actionItem?.title,
        body: current.detailPayload?.provider === 'github' ? current.detailPayload.body : undefined
      },
      React.createElement(
        'Comment',
        {
          onPress: () =>
            current.actionItem?.provider === 'github' &&
            current.addHostedItemComment(current.actionItem),
          disabled: current.mutatingStatus
        },
        current.detailPayload?.comments.map((comment) => comment.body).join(',')
      ),
      React.createElement('CloseReopen', {
        onPress: () =>
          current.actionItem?.provider === 'github' &&
          current.toggleGitHubStatus(current.actionItem),
        disabled: current.mutatingStatus
      })
    )
  }
  await act(async () => {
    renderers.push(create(<Probe />))
  })
  await act(async () => select(a))
  return {
    logical,
    a,
    b,
    client,
    committed,
    read: () => current,
    select: async (selected: Extract<TaskItem, { provider: 'github' }> | null) =>
      act(async () => select(selected)),
    providerPages,
    renderer: renderers.at(-1)!,
    selectProject: async (selected: GitHubProjectRow | null) =>
      act(async () => selectProject(selected)),
    async answer(result: unknown, index = client.requests.length - 1) {
      await act(async () => client.requests[index].resolve(rpcSuccess('reply', result)))
    }
  }
}
it('uses exact old PR metadata, accepted viewed node and review SHA routes without generic preflight, and settles provider errors', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f
      .read()
      .updateGitHubPullRequestMetadata(f.a, { title: 'new title', body: 'new body' })
  })
  expect(f.client.requests.map((request) => request.method)).toEqual(['github.updatePR'])
  expect(f.client.requests[0].args[1]).toMatchObject({
    repo: 'id:clone',
    prNumber: 93,
    prRepo: f.a.source.prRepo,
    updates: { title: 'new title', body: 'new body' }
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read()).toMatchObject({
    actionItem: { title: 'new title' },
    detailPayload: { body: 'new body' },
    mutatingStatus: false
  })
  await act(async () => {
    pending = f.read().toggleGitHubFileViewed(f.a, file)
  })
  expect(f.client.requests.at(-1)).toMatchObject({
    method: 'github.setPRFileViewed',
    args: expect.arrayContaining([
      expect.objectContaining({ pullRequestId: 'PR_fork', prRepo: f.a.source.prRepo })
    ])
  })
  await f.answer(true)
  await pending
  expect(f.read().detailPayload).toMatchObject({ files: [{ viewerViewedState: 'VIEWED' }] })
  await act(async () => f.read().setPrFileCommentDrafts({ 'same.ts:1': 'review' }))
  await act(async () => {
    pending = f.read().addGitHubFileReviewComment(f.a, file, 1)
  })
  expect(f.client.requests.at(-1)?.args[1]).toMatchObject({
    commitId: 'fork-head',
    prRepo: f.a.source.prRepo,
    path: 'same.ts',
    line: 1
  })
  await f.answer({ ok: false, error: 'provider refused' })
  await pending
  expect(f.read()).toMatchObject({ mutatingStatus: false, error: 'provider refused' })
  expect(f.client.requests.some((request) => request.method === 'status.get')).toBe(false)
})
it('late file contents and finally from A cannot publish into same-number B or release B busy ownership', async () => {
  const f = await mount()
  let old!: Promise<void>
  let live!: Promise<void>
  await act(async () => {
    old = f.read().toggleGitHubFileExpansion(f.a, file)
  })
  expect(f.client.requests[0].args[1]).toMatchObject({
    headSha: 'fork-head',
    baseSha: 'fork-base',
    prRepo: f.a.source.prRepo
  })
  await f.select(f.b)
  await act(async () => {
    live = f.read().toggleGitHubFileExpansion(f.b, file)
  })
  await f.answer({ original: 'A', modified: 'A' }, 0)
  await old
  expect(f.read()).toMatchObject({ prFileContents: {}, prFileLoadingPath: 'same.ts' })
  await f.answer({ original: 'B', modified: 'B' }, 1)
  await live
  expect(f.read()).toMatchObject({
    prFileContents: { 'same.ts': { original: 'B' } },
    prFileLoadingPath: null
  })
})
it('suppresses stale publication after a same-client disconnect/reconnect while preserving the acknowledged write', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f.read().updateGitHubPullRequestMetadata(f.a, { body: 'old invocation' })
  })
  await act(async () => {
    f.client.pushState('reconnecting')
    f.client.pushState('connected')
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read().detailPayload).toMatchObject({ body: 'fork' })
  expect(f.read().mutatingStatus).toBe(false)
  expect(f.client.requests).toHaveLength(1)
  expect(
    f.committed.filter(({ name }) => name === 'mutatingStatus').map(({ value }) => value)
  ).toEqual([false, true, false])
  await act(async () => {
    pending = f.read().updateGitHubPullRequestMetadata(f.a, { body: 'fresh invocation' })
  })
  await f.answer({ ok: true })
  await pending
  expect(f.client.requests).toHaveLength(2)
  expect(f.read().detailPayload).toMatchObject({ body: 'fresh invocation' })
  expect(
    f.committed.filter(({ name }) => name === 'mutatingStatus').map(({ value }) => value)
  ).toEqual([false, true, false, true, false])
})

it('keeps the established old PR state route exact while refusing only an unsupported generic issue action', async () => {
  const f = await mount()
  let pending!: Promise<void>
  await act(async () => {
    pending = f.read().toggleGitHubStatus(f.a)
  })
  expect(f.client.requests[0]).toMatchObject({
    method: 'github.updatePRState',
    args: expect.arrayContaining([
      expect.objectContaining({
        prRepo: f.a.source.prRepo,
        prNumber: 93,
        updates: { state: 'closed' }
      })
    ])
  })
  await f.answer({ ok: true })
  await pending
  expect(f.read().actionItem).toBeNull()
  const issue = {
    ...f.a,
    source: {
      ...f.a.source,
      type: 'issue' as const,
      prRepo: undefined,
      url: 'https://github.corp/fork/widgets/issues/93'
    }
  }
  await f.select(issue)
  await act(async () => {
    pending = f.read().toggleGitHubStatus(issue)
  })
  expect(f.client.requests.at(-1)?.method).toBe('status.get')
  await f.answer({ runtimeId: 'old', capabilities: [] })
  await pending
  expect(f.read()).toMatchObject({
    actionItem: issue,
    mutatingStatus: false,
    error: expect.stringContaining('Update Orca')
  })
  expect(f.client.requests.map((request) => request.method)).toEqual([
    'github.updatePRState',
    'status.get'
  ])
})

it.each([true, false])(
  'serializes real mutation producers through leave/re-entry and retires old feedback (ok=%s)',
  async (ok) => {
    const f = await mount()
    let old!: Promise<void>
    await act(async () => {
      old = f.read().toggleGitHubStatus(f.a)
    })
    expect(f.read().mutatingStatus).toBe(true)
    await f.select(null)
    await f.select(f.b)
    await act(async () => {
      await f.read().updateGitHubPullRequestMetadata(f.b, { body: 'blocked' })
    })
    expect(f.client.requests).toHaveLength(1)
    await f.select(f.a)
    await act(async () => f.read().setItemCommentDraft('new visit draft'))
    await f.answer({ ok, error: ok ? undefined : 'old failure' })
    await old
    expect(f.read()).toMatchObject({
      actionItem: f.a,
      itemCommentDraft: 'new visit draft',
      error: '',
      mutatingStatus: false
    })
    let fresh!: Promise<void>
    await act(async () => {
      fresh = f.read().toggleGitHubStatus(f.a)
    })
    await f.answer({ ok: true })
    await fresh
    expect(f.read()).toMatchObject({ actionItem: null, mutatingStatus: false })
  }
)

it.each(['comment', 'status'] as const)(
  'releases serial %s after real connected-to-connected migration and permits a fresh command',
  async (kind) => {
    const f = await mount()
    await act(async () => f.read().setItemCommentDraft('origin comment'))
    let old!: Promise<void>
    await act(async () => {
      old =
        kind === 'comment' ? f.read().addHostedItemComment(f.a) : f.read().toggleGitHubStatus(f.a)
    })
    const next = createFakeRpcClient()
    await act(async () => f.logical.migrateTo(next, 'lan'))
    await f.answer({
      ok: true,
      comment: { id: 'old', body: 'origin comment', createdAt: '', author: 'you' }
    })
    await old
    expect(f.read()).toMatchObject({
      mutatingStatus: false,
      actionItem: f.a,
      itemCommentDraft: 'origin comment'
    })
    let fresh!: Promise<void>
    await act(async () => {
      fresh = f.read().toggleGitHubStatus(f.a)
    })
    expect(next.requests).toHaveLength(1)
    await act(async () => next.requests[0].resolve(rpcSuccess('fresh', { ok: true })))
    await fresh
    expect(f.read()).toMatchObject({ mutatingStatus: false, actionItem: null })
  }
)

it('all eighteen production mutation admissions share the synchronous serial owner from one retained render snapshot', async () => {
  const f = await mount()
  await act(async () => {
    f.read().setItemCommentDraft('comment')
    f.read().setItemReplyDrafts({ '5': 'reply' })
    f.read().setPrFileCommentDrafts({ 'same.ts:1': 'line comment' })
  })
  const snapshot = f.read()
  const gitlab: Extract<TaskItem, { provider: 'gitlab' }> = {
    ...f.a,
    provider: 'gitlab',
    source: { ...f.a.source, type: 'issue', state: 'opened' }
  }
  const linear: Extract<TaskItem, { provider: 'linear' }> = {
    ...f.a,
    provider: 'linear',
    source: {
      id: 'linear',
      identifier: 'L-1',
      title: 'linear',
      url: 'https://linear.app/L-1',
      state: { name: 'Todo', type: 'unstarted', color: '' },
      team: { id: 'team', name: 'Team', key: 'T' },
      labels: [],
      priority: 0,
      updatedAt: ''
    }
  }
  const comment = { id: 5, body: 'parent', author: 'me', createdAt: '', threadId: 'thread' }
  let pending!: Promise<void>
  await act(async () => {
    pending = snapshot.toggleGitHubStatus(f.a)
    await snapshot.toggleGitHubStatus(f.a)
    await snapshot.updateGitHubIssueMetadata(f.a, { body: 'issue' })
    await snapshot.updateGitHubPullRequestMetadata(f.a, { body: 'PR' })
    await snapshot.updateGitLabIssueMetadata(gitlab, { body: 'GitLab' })
    await snapshot.addHostedItemComment(f.a)
    await snapshot.requestGitHubReviewers(f.a, ['reviewer'])
    await snapshot.refreshGitHubChecks(f.a)
    await snapshot.rerunGitHubChecks(f.a, true)
    await snapshot.toggleGitHubFileViewed(f.a, file)
    await snapshot.toggleGitHubReviewThread(f.a, comment)
    await snapshot.addGitHubFileReviewComment(f.a, file, 1)
    await snapshot.replyToGitHubComment(f.a, comment)
    await snapshot.mergeHostedReview(f.a, 'squash')
    await snapshot.setLinearStatus(linear, { id: 'done', name: 'Done', type: 'completed' })
    await snapshot.toggleGitLabStatus(gitlab)
    await snapshot.addLinearComment(linear)
    await snapshot.openLinearSubIssue({
      id: 'child',
      identifier: 'L-2',
      title: 'child',
      url: linear.source.url
    })
    await snapshot.createLinearSubIssue(linear)
  })
  expect(f.client.requests).toHaveLength(1)
  await f.answer({ ok: false, error: 'refused' })
  await pending
  expect(f.read().mutatingStatus).toBe(false)
})

it('same-SHA A re-entry file successor retains loading and contents after old A completion', async () => {
  const f = await mount()
  let old!: Promise<void>
  let fresh!: Promise<void>
  await act(async () => {
    old = f.read().toggleGitHubFileExpansion(f.a, file)
  })
  await f.select(null)
  await f.select(f.b)
  await f.select(f.a)
  await act(async () => {
    fresh = f.read().toggleGitHubFileExpansion(f.a, file)
  })
  await f.answer({ original: 'old', modified: 'old' }, 0)
  await old
  expect(f.read()).toMatchObject({ prFileContents: {}, prFileLoadingPath: 'same.ts' })
  await f.answer({ original: 'fresh', modified: 'fresh' }, 1)
  await fresh
  expect(f.read()).toMatchObject({
    prFileLoadingPath: null,
    prFileContents: { 'same.ts': { modified: 'fresh' } }
  })
})

it.each([10, 100])(
  'shipping metadata producers admit zero hidden operations across %i real selections while comment/status remain usable',
  async (count) => {
    const f = await mount()
    for (let index = 0; index < count; index++) {
      const selected = {
        ...f.a,
        key: `item-${index}`,
        source: {
          ...f.a.source,
          number: index + 1,
          url: `https://github.corp/fork/widgets/pull/${index + 1}`
        }
      }
      await f.select(selected)
      expect(
        f.renderer.root.find((node) => {
          const type: unknown = node.type
          return type === 'TaskDetail'
        }).props.body
      ).toBe('fork')
    }
    // No hidden list attempt or status frame crosses the actual RpcClient boundary, hence no downstream gh/provider page can be admitted.
    expect(f.client.requests).toEqual([])
    await act(async () => f.read().setItemCommentDraft('visible comment'))
    let comment!: Promise<void>
    await act(async () => {
      comment = f.renderer.root
        .find((node) => {
          const type: unknown = node.type
          return type === 'Comment'
        })
        .props.onPress()
    })
    await f.answer({
      ok: true,
      comment: { id: 'visible', body: 'visible comment', author: 'me', createdAt: '' }
    })
    await comment
    expect(
      f.renderer.root.find((node) => {
        const type: unknown = node.type
        return type === 'Comment'
      }).children
    ).toContain('visible comment')
    let close!: Promise<void>
    await act(async () => {
      close = f.renderer.root
        .find((node) => {
          const type: unknown = node.type
          return type === 'CloseReopen'
        })
        .props.onPress()
    })
    await f.answer({ ok: true })
    await close
    expect(f.read()).toMatchObject({ actionItem: null, mutatingStatus: false })
    expect(f.client.requests.map((request) => request.method)).toEqual([
      'github.addIssueComment',
      'github.updatePRState'
    ])
  }
)
it('the actual Project detail reset retires a task file and X→Y Project file before its successor paints', async () => {
  const f = await mount()
  let task!: Promise<void>
  let x!: Promise<void>
  let y!: Promise<void>
  await act(async () => {
    task = f.read().toggleGitHubFileExpansion(f.a, file)
  })
  const loading = () =>
    f.committed.filter(({ name }) => name === 'prFileLoadingPath').map(({ value }) => value)
  expect(loading()).toEqual([{ $rpc: 'null' }, 'same.ts'])
  await f.selectProject(projectRow('X'))
  expect(loading()).toEqual([{ $rpc: 'null' }, 'same.ts', { $rpc: 'null' }])
  await f.answer(
    {
      ok: true,
      details: {
        body: 'X',
        comments: [],
        headSha: 'same-head',
        baseSha: 'same-base',
        files: [file]
      }
    },
    1
  )
  await act(async () => {
    x = f.read().toggleProjectGitHubFileExpansion(projectRow('X'), file)
  })
  await f.answer({ original: 'task', modified: 'task' }, 0)
  await task
  expect(f.read().prFileLoadingPath).toBe('same.ts')
  expect(loading()).toEqual([{ $rpc: 'null' }, 'same.ts', { $rpc: 'null' }, 'same.ts'])
  await f.selectProject(projectRow('Y'))
  await f.answer(
    {
      ok: true,
      details: {
        body: 'Y',
        comments: [],
        headSha: 'same-head',
        baseSha: 'same-base',
        files: [file]
      }
    },
    3
  )
  await act(async () => {
    y = f.read().toggleProjectGitHubFileExpansion(projectRow('Y'), file)
  })
  await f.answer({ original: 'X', modified: 'X' }, 2)
  await x
  expect(f.read()).toMatchObject({ prFileContents: {}, prFileLoadingPath: 'same.ts' })
  const beforeY = structuredClone(f.committed)
  expect(loading()).toEqual([
    { $rpc: 'null' },
    'same.ts',
    { $rpc: 'null' },
    'same.ts',
    { $rpc: 'null' },
    'same.ts'
  ])
  await f.answer({ original: 'Y', modified: 'Y' }, 4)
  await y
  expect(f.read()).toMatchObject({
    prFileContents: { 'same.ts': { modified: 'Y' } },
    prFileLoadingPath: null
  })
  expect(loading().at(-1)).toEqual({ $rpc: 'null' })
  expect(beforeY.filter(({ name }) => name === 'prFileContents')).toEqual([
    { name: 'prFileContents', value: {} }
  ])
  expect(f.committed.filter(({ name }) => name === 'prFileContents')).toEqual([
    { name: 'prFileContents', value: {} },
    { name: 'prFileContents', value: { 'same.ts': { original: 'Y', modified: 'Y' } } }
  ])
})

it('terminal mutation releases while its real list refresh is pending, and obsolete refresh cannot replace a newer query', async () => {
  const f = await mount()
  let resolvePage!: (value: Awaited<ReturnType<typeof f.providerPages>>) => void
  f.providerPages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePage = resolve
      })
  )
  let command!: Promise<void>
  await act(async () => {
    command = f.read().toggleGitHubStatus(f.a)
  })
  await f.answer({ ok: true })
  await command
  expect(f.read()).toMatchObject({ mutatingStatus: false, refreshing: true })
  const obsoleteRefresh = f.read().captureTaskListRefresh()
  await act(async () => {
    f.read().setAppliedQuery('new query')
  })
  await act(async () => {
    obsoleteRefresh()
  })
  expect(f.providerPages).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolvePage({
      items: [],
      sourcesByRepoId: {},
      sourceErrors: [],
      sourceFallbacks: [],
      failedCount: 0
    })
  })
  expect(f.read().items).toEqual([f.a, f.b])
  await f.select(f.b)
  let fresh!: Promise<void>
  await act(async () => {
    fresh = f.read().toggleGitHubStatus(f.b)
  })
  await f.answer({ ok: true })
  await fresh
  expect(f.read()).toMatchObject({ mutatingStatus: false, refreshing: false })
  expect(f.providerPages).toHaveBeenCalledTimes(2)
})
