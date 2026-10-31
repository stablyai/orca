import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as mutations from '../linear/linear-issue-mutations'
import * as comments from '../linear/linear-issue-comments'
import * as relations from '../linear/issue-relation-write'
import { LinearWriteFailure } from '../linear/linear-issue-write-support'
import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'
import type { LinearIssueTaskUpdateRequest } from './runtime-linear-command-dependencies'

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

function commands(listResolvedWorktrees: () => Promise<[]> = async () => []) {
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
    emitClientEvent: () => {}
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

it('returns confirmed task fields without a second issue lookup', async () => {
  const c = commands()
  const confirmed = { ...issue, priority: 2 }
  vi.mocked(c.readLinearAgentIssueWriteRecord)
    .mockResolvedValueOnce(issue)
    .mockRejectedValue(new Error('unexpected second lookup'))
  vi.spyOn(mutations, 'updateIssueForAgent').mockResolvedValue(confirmed)
  await expect(
    c.linearIssueUpdateTask({ input: 'ENG-1', operation: 'priority', priority: 2 })
  ).resolves.toMatchObject({ current: { priority: 2 }, meta: { alreadySet: false } })
  expect(c.readLinearAgentIssueWriteRecord).toHaveBeenCalledTimes(1)
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

it.each(['write', 'total'] as const)(
  'reports a truthful cause when the %s deadline ends an invoked write',
  async (deadline) => {
    const c = commands()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    let release = () => {}
    const confirmation = new Promise<typeof issue>((resolve) => {
      release = () => resolve({ ...issue, state: { id: 'done', name: 'Done' } })
    })
    vi.mocked(mutations.updateIssueForAgent).mockImplementation(
      (_id, _fields, _workspace, options) => {
        options?.beforeInvoke?.()
        return confirmation
      }
    )
    let outcome: unknown
    const pending = c.linearIssueSetState({ input: 'ENG-1', to: 'Done' }).catch((error) => {
      outcome = error
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(mutations.updateIssueForAgent).toHaveBeenCalledTimes(1)
      if (deadline === 'write') {
        await vi.advanceTimersByTimeAsync(25_000)
      } else {
        const totalTimeout = timers.mock.calls.find(([, delay]) => delay === 55_000)?.[0]
        if (typeof totalTimeout !== 'function') {
          throw new Error('Total deadline not scheduled')
        }
        vi.setSystemTime(Date.now() + 55_000)
        // Deliver the real total callback independently of the earlier write timer.
        totalTimeout()
        await vi.advanceTimersByTimeAsync(0)
      }
      await pending
      expect(outcome).toMatchObject({
        code: 'linear_write_unconfirmed',
        data: {
          cause: 'Linear write deadline elapsed before confirmation.',
          nextSteps: [expect.stringContaining('orca linear issue ENG-1')]
        }
      })
    } finally {
      release()
      await pending
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(mutations.updateIssueForAgent).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it.each(['status', 'relation'] as const)(
  'reports %s uncertainty only after invocation when the caller disconnects',
  async (verb) => {
    const c = commands()
    const caller = new AbortController()
    let release = () => {}
    const confirmation = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('lost confirmation'))
    })
    vi.mocked(mutations.updateIssueForAgent).mockImplementation(
      (_id, _fields, _workspace, options) => {
        options?.beforeInvoke?.()
        return confirmation
      }
    )
    vi.mocked(relations.writeIssueRelation).mockImplementation((params) => {
      params.beforeInvoke?.()
      return confirmation
    })
    vi.mocked(c.resolveLinearAgentWriteTarget)
      .mockResolvedValueOnce(target)
      .mockResolvedValue({ ...target, issue: { ...issue, id: 'issue-2' } })
    const pending =
      verb === 'status'
        ? c.linearIssueSetState({ input: 'ENG-1', to: 'Done' }, caller.signal)
        : c.linearIssueRelationWrite(
            { input: 'ENG-1', relatedInput: 'ENG-2', relationship: 'blocks', operation: 'add' },
            caller.signal
          )
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: { nextSteps: [expect.stringContaining('orca linear issue ENG-1')] }
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      caller.abort()
      await rejected
      expect(
        verb === 'status' ? mutations.updateIssueForAgent : relations.writeIssueRelation
      ).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await pending.catch(() => {})
    }
  }
)

it.each(['comment', 'attach', 'create'] as const)(
  'returns a matching %s replay without attempting a mutation',
  async (verb) => {
    const c = commands()
    const writeId = '11111111-1111-4111-8111-111111111111'
    const record = {
      id: writeId,
      url: issue.url,
      body: 'body',
      title: 'Link',
      issue,
      parentId: null,
      threadRootId: writeId
    }
    vi.spyOn(c, 'getMatchingLinearCommentWrite').mockResolvedValue(record)
    vi.spyOn(c, 'getMatchingLinearAttachmentWrite').mockResolvedValue(record)
    vi.spyOn(c, 'getMatchingLinearCreatedIssue').mockResolvedValue({ ...issue, id: writeId })
    const pending =
      verb === 'comment'
        ? c.linearIssueAddComment({ input: 'ENG-1', body: 'body', writeId })
        : verb === 'attach'
          ? c.linearIssueAttachLink({ input: 'ENG-1', url: issue.url, writeId })
          : c.linearIssueCreate({ teamInput: 'ENG', title: 'Title', writeId })
    await expect(pending).resolves.toMatchObject({ meta: { writeId, deduplicated: true } })
    expect(comments.addIssueCommentForAgent).not.toHaveBeenCalled()
    expect(comments.createIssueAttachment).not.toHaveBeenCalled()
    expect(mutations.createIssueForAgent).not.toHaveBeenCalled()
  }
)
