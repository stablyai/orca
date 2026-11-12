import type { RuntimeLinearCommandPorts } from './runtime-linear-command-base'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as mutations from '../../../linear/issues/linear-issue-mutations'
import * as comments from '../../../linear/issues/linear-issue-comments'
import * as relations from '../../../linear/issues/issue-relation-write'
import { LinearWriteFailure } from '../../../linear/issues/linear-issue-write-support'
import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'
import type { LinearIssueTaskUpdateRequest } from '../../../../shared/linear/agent-access'

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Title',
  description: '',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'todo', name: 'Todo' },
  parent: null,
  project: null,
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: []
}
const target = { issue, workspaceId: 'w1' }
const team = { ...issue.team, workspaceId: 'w1' }

function commands(
  listResolvedWorktrees: RuntimeLinearCommandPorts['listResolvedWorktrees'] = async () => [],
  emitClientEvent: RuntimeLinearCommandPorts['emitClientEvent'] = () => {}
) {
  const unusedSelector = async () => {
    throw new Error('unused')
  }
  const ports = {
    runtimeAvailable: () => true,
    showTerminal: async () => {
      throw new Error('unused')
    },
    resolveWorktreeSelector: unusedSelector,
    resolveWorkspaceSelector: unusedSelector,
    listResolvedWorktrees,
    setWorktreeMeta: () => {},
    emitClientEvent
  }
  const result = new RuntimeLinearReadCommands(ports)
  vi.spyOn(result, 'resolveLinearAgentWriteTarget').mockResolvedValue(target)
  vi.spyOn(result, 'resolveLinearCreateTeam').mockResolvedValue(team)
  vi.spyOn(result, 'getLinearTeamStatesForWrite').mockResolvedValue([
    { id: 'done', name: 'Done', type: 'completed', color: '#888888', position: 1 }
  ])
  vi.spyOn(result, 'readLinearAgentIssueWriteRecord').mockResolvedValue(issue)
  vi.spyOn(result, 'getLinearViewerForWrite').mockResolvedValue({ id: 'user-1' })
  vi.spyOn(result, 'getLinearTeamLabelsForWrite').mockResolvedValue([
    { id: 'label-1', name: 'Bug', color: '#888888' }
  ])
  return result
}

type Commands = ReturnType<typeof commands>
const taskUpdates: LinearIssueTaskUpdateRequest[] = [
  { operation: 'priority', priority: 2 },
  { operation: 'assignee', assigneeMe: true },
  { operation: 'labels', labelMode: 'add', labels: ['Bug'] },
  { operation: 'estimate', estimate: 3 },
  { operation: 'dueDate', dueDate: '2026-11-01' }
]
const actions: { name: string; run: (c: Commands, signal: AbortSignal) => Promise<unknown> }[] = [
  {
    name: 'status',
    run: (c, signal) => c.linearIssueSetState({ input: 'ENG-1', to: 'Done' }, signal)
  },
  ...taskUpdates.map((update) => ({
    name: update.operation,
    run: (c: Commands, signal: AbortSignal) =>
      c.linearIssueUpdateTask({ ...update, input: 'ENG-1' }, signal)
  })),
  {
    name: 'save update',
    run: (c, signal) => c.linearSaveIssue({ input: 'ENG-1', title: 'New' }, signal)
  },
  {
    name: 'save create',
    run: (c, signal) => c.linearSaveIssue({ team: 'ENG', title: 'New' }, signal)
  },
  {
    name: 'create',
    run: (c, signal) => c.linearIssueCreate({ teamInput: 'ENG', title: 'New' }, signal)
  },
  {
    name: 'comment',
    run: (c, signal) => c.linearIssueAddComment({ input: 'ENG-1', body: 'body' }, signal)
  },
  {
    name: 'attach',
    run: (c, signal) =>
      c.linearIssueAttachLink({ input: 'ENG-1', url: 'https://example.com' }, signal)
  },
  ...(['add', 'remove'] as const).map((operation) => ({
    name: `relation ${operation}`,
    run: (c: Commands, signal: AbortSignal) =>
      c.linearIssueRelationWrite(
        { input: 'ENG-1', relatedInput: 'ENG-2', relationship: 'blocks', operation },
        signal
      )
  }))
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(mutations, 'updateIssueForAgent').mockRejectedValue(new Error('unexpected mutation'))
  vi.spyOn(mutations, 'createIssueForAgent').mockRejectedValue(new Error('unexpected mutation'))
  vi.spyOn(comments, 'addIssueCommentForAgent').mockRejectedValue(new Error('unexpected mutation'))
  vi.spyOn(comments, 'createIssueAttachment').mockRejectedValue(new Error('unexpected mutation'))
  vi.spyOn(relations, 'writeIssueRelation').mockRejectedValue(new Error('unexpected mutation'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(actions)('bounds $name preparation and never invokes after it expires', async ({ run }) => {
  const c = commands()
  let release = () => {}
  const held = new Promise<typeof target>((resolve) => {
    release = () => resolve(target)
  })
  vi.mocked(c.resolveLinearAgentWriteTarget).mockReturnValue(held)
  vi.mocked(c.resolveLinearCreateTeam).mockImplementation(async () => {
    await held
    return team
  })
  let outcome: unknown
  const pending = run(c, new AbortController().signal).catch((error) => {
    outcome = error
  })
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(outcome).toMatchObject({
      code: 'linear_timeout',
      message: 'The Linear action stopped before a change was attempted.'
    })
    release()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
    expect(mutations.createIssueForAgent).not.toHaveBeenCalled()
    expect(comments.addIssueCommentForAgent).not.toHaveBeenCalled()
    expect(comments.createIssueAttachment).not.toHaveBeenCalled()
    expect(relations.writeIssueRelation).not.toHaveBeenCalled()
  } finally {
    release()
    await pending
  }
})

it.each(actions)('cancels $name preparation with the caller', async ({ run }) => {
  const c = commands()
  const controller = new AbortController()
  let release = () => {}
  const held = new Promise<typeof target>((resolve) => {
    release = () => resolve(target)
  })
  vi.mocked(c.resolveLinearAgentWriteTarget).mockReturnValue(held)
  vi.mocked(c.resolveLinearCreateTeam).mockImplementation(async () => {
    await held
    return team
  })
  let outcome: unknown
  const pending = run(c, controller.signal).catch((error) => {
    outcome = error
  })
  try {
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toMatchObject({ code: 'linear_timeout' })
    release()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
    expect(mutations.createIssueForAgent).not.toHaveBeenCalled()
    expect(comments.addIssueCommentForAgent).not.toHaveBeenCalled()
    expect(comments.createIssueAttachment).not.toHaveBeenCalled()
    expect(relations.writeIssueRelation).not.toHaveBeenCalled()
  } finally {
    release()
    await pending
  }
})

it.each(['stalled', 'rejected'])(
  'returns confirmed success while notification is %s',
  async (state) => {
    vi.spyOn(mutations, 'updateIssueForAgent').mockResolvedValue({
      ...issue,
      state: { id: 'done', name: 'Done' }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release = () => {}
    const notification = new Promise<[]>((resolve) => {
      release = () => resolve([])
    })
    const c = commands(() =>
      state === 'stalled' ? notification : Promise.reject(new Error('notification unavailable'))
    )
    let outcome: unknown
    const pending = c.linearIssueSetState({ input: 'ENG-1', to: 'Done' }).then(
      (value) => {
        outcome = value
      },
      (error) => {
        outcome = error
      }
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toMatchObject({ state: { id: 'done' } })
    } finally {
      release()
      await pending
    }
  }
)

it.each(['comment', 'attach', 'create'] as const)(
  'keeps %s duplicate-id recovery within the remaining action lifetime',
  async (verb) => {
    const writeId = '11111111-1111-4111-8111-111111111111'
    for (const expires of [false, true]) {
      const c = commands()
      const record = {
        id: writeId,
        url: issue.url,
        body: 'body',
        title: 'Link',
        issue,
        parentId: null,
        threadRootId: writeId
      }
      let releaseRecovery = () => {}
      let releaseMutation = () => {}
      const recovery = new Promise<void>((resolve) => {
        releaseRecovery = resolve
      })
      const mutation = new Promise<void>((resolve) => {
        releaseMutation = resolve
      })
      vi.spyOn(c, 'getMatchingLinearCommentWrite')
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => {
          await recovery
          return record
        })
      vi.spyOn(c, 'getMatchingLinearAttachmentWrite')
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => {
          await recovery
          return record
        })
      vi.spyOn(c, 'getMatchingLinearCreatedIssue')
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => {
          await recovery
          return { ...issue, id: writeId }
        })
      const duplicate = async (beforeInvoke?: () => void) => {
        beforeInvoke?.()
        await mutation
        throw new LinearWriteFailure('duplicate_id', 'Already exists')
      }
      vi.mocked(comments.addIssueCommentForAgent).mockImplementation(
        (_id, _body, _workspace, options) => duplicate(options.beforeInvoke)
      )
      vi.mocked(comments.createIssueAttachment).mockImplementation(
        (_id, _input, _workspace, options) => duplicate(options?.beforeInvoke)
      )
      vi.mocked(mutations.createIssueForAgent).mockImplementation(
        (_team, _title, _body, _workspace, options) => duplicate(options.beforeInvoke)
      )
      const invoke = () =>
        verb === 'comment'
          ? c.linearIssueAddComment({ input: 'ENG-1', body: 'body', writeId })
          : verb === 'attach'
            ? c.linearIssueAttachLink({ input: 'ENG-1', url: issue.url, writeId })
            : c.linearIssueCreate({ teamInput: 'ENG', title: 'Title', writeId })
      let outcome: unknown
      const pending = invoke().then(
        (value) => {
          outcome = value
        },
        (error) => {
          outcome = error
        }
      )
      const provider =
        verb === 'comment'
          ? comments.addIssueCommentForAgent
          : verb === 'attach'
            ? comments.createIssueAttachment
            : mutations.createIssueForAgent
      try {
        await vi.advanceTimersByTimeAsync(20_000)
        releaseMutation()
        await vi.advanceTimersByTimeAsync(0)
        if (expires) {
          await vi.advanceTimersByTimeAsync(5_000)
          expect(outcome).toMatchObject({
            code: 'linear_write_unconfirmed',
            data: {
              writeId,
              cause: 'Linear write deadline elapsed before confirmation.',
              nextSteps: [expect.stringContaining(`--write-id=${writeId}`)]
            }
          })
        } else {
          releaseRecovery()
          await pending
          expect(outcome).toMatchObject({ meta: { writeId, deduplicated: true } })
        }
        expect(provider).toHaveBeenCalledTimes(1)
      } finally {
        releaseMutation()
        releaseRecovery()
        await pending
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(provider).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      vi.mocked(provider).mockClear()
    }
  }
)

it('publishes successful command writes for each linked row with account identity intact', async () => {
  vi.mocked(mutations.updateIssueForAgent).mockResolvedValue({
    ...issue,
    state: { id: 'done', name: 'Done' }
  })
  const base: ResolvedWorktree = {
    id: 'wt-1',
    repoId: 'repo',
    path: '/repo/wt-1',
    head: 'head',
    branch: 'branch',
    isBare: false,
    isMainWorktree: false,
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: 'eng-1',
    linkedLinearIssueWorkspaceId: 'w1',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path: '/repo/wt-1',
      head: 'head',
      branch: 'branch',
      isBare: false,
      isMainWorktree: false
    }
  }
  const emit = vi.fn()
  const c = commands(
    async () => [
      base,
      { ...base, id: 'wt-2' },
      { ...base, id: 'wrong-account', linkedLinearIssueWorkspaceId: 'w2' }
    ],
    emit
  )
  await c.linearIssueSetState({ input: 'ENG-1', to: 'Done' })
  await vi.advanceTimersByTimeAsync(0)
  expect(emit.mock.calls).toEqual([
    [
      {
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'wt-1',
        identifier: 'ENG-1',
        workspaceId: 'w1'
      }
    ],
    [
      {
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'wt-2',
        identifier: 'ENG-1',
        workspaceId: 'w1'
      }
    ]
  ])
})
