import { expect, it, vi } from 'vitest'
import type { IssueInfo, PRInfo } from '../../shared/github/pull-requests/pull-request-types'
import { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemLinkKind } from '../../shared/bots/bot-items'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'

const worker: BotWorkWorker = {
  dispatchId: 'ctx_1',
  taskId: 'task_1',
  title: 'Fix share dialog',
  agent: 'codex',
  state: 'completed',
  stopped: false,
  startFailed: false,
  host: 'local',
  hostName: null,
  worktreeId: 'repo-1::/wt/share',
  startedAt: 1,
  settledAt: 2
}
// The same Task's earlier attempt on a paired server; a local retry (ctx_1) finished it.
const serverAttempt: BotWorkWorker = { ...worker, dispatchId: 'ctx_srv', host: 'env-1' }
vi.mock('./bot-work-runtime', () => ({
  readWorkers: async (_runtime: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, id === 'ctx_srv' ? serverAttempt : worker])),
  readWorkspace: async () => ({
    name: 'share',
    branch: 'share',
    head: 'abc',
    pullRequest: {
      number: 9,
      url: pr.url,
      state: 'open',
      checks: 'failure',
      review: null,
      headSha: null
    }
  })
}))

const pr: PRInfo = {
  number: 9,
  title: 'Share dialog',
  state: 'open',
  url: 'https://github.com/acme/app/pull/9',
  checksStatus: 'failure',
  updatedAt: '2026-11-14T00:00:00Z',
  mergeable: 'MERGEABLE'
}
const issue: IssueInfo = {
  number: 7,
  title: 'Viewers can edit',
  state: 'closed',
  url: 'https://github.com/acme/app/issues/7',
  labels: []
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pr and url links never read workers
const join = new BotItemLinkJoin({} as BotWorkRuntime, () => ({
  pr: { 'acme/app#9': { data: pr, fetchedAt: 5 } },
  issue: { 'acme/app#7': { data: issue, fetchedAt: 5 } }
}))
const link = (kind: BotItemLinkKind, ref: string) => ({ itemUid: 'i1', kind, ref, addedEvent: 1 })

it('passes a cached PR its title', () => {
  expect(join.linkView(link('pr', 'acme/app#9'), undefined)).toMatchObject({
    kind: 'pr',
    pr: { shown: true, title: 'Share dialog', state: 'open', checks: 'failure' }
  })
})

it('passes a cached issue link its title and state; an unread one stays a plain link', () => {
  expect(join.linkView(link('url', 'https://github.com/Acme/App/issues/7#top'), undefined)).toEqual(
    {
      kind: 'url',
      ref: 'https://github.com/Acme/App/issues/7#top',
      issue: { title: 'Viewers can edit', state: 'closed' }
    }
  )
  expect(join.linkView(link('url', 'https://github.com/acme/app/issues/8'), undefined)).toEqual({
    kind: 'url',
    ref: 'https://github.com/acme/app/issues/8'
  })
})

it('passes a local worker’s PR the worktree it is read for, so a stale read can be refreshed', async () => {
  const reads = await join.readLinkedWorkers(['ctx_1'])
  expect(reads.get('ctx_1')?.pr).toMatchObject({
    shown: true,
    state: 'open',
    checkedAt: 5,
    worktreeId: 'repo-1::/wt/share'
  })
})

it("keeps a server attempt's report empty when a local retry of its Task reported", async () => {
  const runtime = {
    getOrchestrationDb: () => ({ getTask: () => ({ result: '{"subject":"Local result"}' }) })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: report() reads only getTask
  const withTasks = new BotItemLinkJoin(runtime as unknown as BotWorkRuntime, () => ({
    pr: {},
    issue: {}
  }))
  const reads = await withTasks.readLinkedWorkers(['ctx_1', 'ctx_srv'])
  expect(reads.get('ctx_1')?.report).toEqual({ subject: 'Local result', body: null })
  expect(reads.get('ctx_srv')?.report).toBeNull()
})
