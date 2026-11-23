import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { botWorkHasPrBranch, botWorkRowsForRuntime, type BotWorkPrHead } from './bot-work-pr-branch'
import { BotWorkRecord, type BotWorkWorker, type BotWorkWorkspace } from './bot-work-record'
import { botWorkStoreFile } from './bot-work-ops'
import { workerBotWork } from './bot-work-worker.test-fixture'

const REPO = { repoId: 7, repoFullName: 'acme/app' }
const PR: BotWorkPrHead = { ...REPO, number: 12, head: REPO, headRef: 'feature-a' }

const WORKER: BotWorkWorker = {
  dispatchId: 'd-1',
  taskId: 't-1',
  title: 'work',
  agent: 'claude',
  state: 'working',
  stopped: false,
  startFailed: false,
  host: 'local',
  hostName: null,
  worktreeId: 'repo-1::/work/a',
  startedAt: 1,
  settledAt: null
}

describe('a pull request saved on the work record', () => {
  const dirs: string[] = []
  const opened: { dispose: () => void }[] = []
  afterEach(() => {
    for (const store of opened.splice(0)) {
      store.dispose()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function setup(bots: readonly string[] = ['bot-1']) {
    const dir = mkdtempSync(join(tmpdir(), 'bot-work-pr-'))
    dirs.push(dir)
    const work = workerBotWork(botWorkStoreFile(dir))
    opened.push(work)
    const store = work.store
    const workspace: BotWorkWorkspace = {
      name: 'a',
      branch: 'feature-a',
      head: 'h1',
      pullRequest: null
    }
    const record = new BotWorkRecord({
      store: () => store,
      worker: async () => WORKER,
      workspace: async () => ({ ...workspace }),
      conversationTitle: () => null,
      turnAddress: async () => null
    })
    const row = (await store.bind({
      botId: 'bot-1',
      address: { source: 'chat', externalId: 'home-chat' },
      taskId: WORKER.taskId,
      dispatchId: WORKER.dispatchId,
      host: 'local',
      askedInApp: true
    }))!
    const guard = (pr: BotWorkPrHead = PR) =>
      botWorkHasPrBranch(
        botWorkRowsForRuntime(
          record,
          (botId) => bots.includes(botId),
          async () => ({ id: REPO.repoId, fullName: REPO.repoFullName })
        ),
        pr
      )
    return { store, record, row, workspace, guard }
  }

  it('the guard keeps skipping a PR its branch match saved, after the branch is renamed', async () => {
    const { store, row, workspace, guard } = await setup()
    expect(await guard()).toBe(true)
    workspace.branch = 'feature-b'
    expect(await guard()).toBe(true)
    // Closed rows keep their PRs.
    await store.close(row, 'stopped')
    expect(await guard()).toBe(true)
  })

  it('saves the PR the workspace row shows, so a renamed branch still matches', async () => {
    const { record, workspace, guard } = await setup()
    workspace.pullRequest = {
      number: 12,
      url: 'https://github.com/Acme/App/pull/12',
      state: 'open',
      checks: 'pending',
      review: null,
      headSha: 'h1'
    }
    await record.list('bot-1')
    workspace.branch = 'feature-b'
    expect(await guard()).toBe(true)
  })

  it('fills in the repository id of a PR saved by name, so it matches after a repository rename', async () => {
    const { record, workspace, guard } = await setup()
    workspace.pullRequest = {
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
      state: 'open',
      checks: 'pending',
      review: null,
      headSha: 'h1'
    }
    await record.list('bot-1')
    workspace.branch = 'feature-b'
    expect(await guard()).toBe(true)
    const renamed = { repoId: REPO.repoId, repoFullName: 'acme/renamed' }
    expect(await guard({ ...PR, ...renamed, head: renamed })).toBe(true)
  })

  it('without a save, a renamed branch no longer matches', async () => {
    const { workspace, guard } = await setup()
    workspace.branch = 'feature-b'
    expect(await guard()).toBe(false)
  })

  it("ignores a deleted bot's saved PRs", async () => {
    const first = await setup()
    expect(await first.guard()).toBe(true)
    const gone = botWorkHasPrBranch(
      botWorkRowsForRuntime(
        first.record,
        () => false,
        async () => null
      ),
      PR
    )
    expect(await gone).toBe(false)
  })
})
