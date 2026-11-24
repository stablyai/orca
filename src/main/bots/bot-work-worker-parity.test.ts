import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { botActiveWorkSection } from './bot-active-work'
import { BotWorkRecord, type BotWorkWorker, type BotWorkWorkspace } from './bot-work-record'
import { botWorkStoreFile, inProcessBotWork, type BotWorkRemote } from './bot-work-ops'
import { BotWorkStore } from './bot-work-store'
import { workerBotWork } from './bot-work-worker.test-fixture'

const THREAD = { source: 'slack', externalId: 'T1:C1:1.0' } as const
const CHAT = { source: 'chat', externalId: 'home-chat' } as const
const WORKSPACE: BotWorkWorkspace = {
  name: 'fix-login',
  branch: 'fix-login',
  head: 'h1',
  pullRequest: {
    number: 12,
    url: 'https://github.com/acme/web/pull/12',
    state: 'open',
    checks: 'pending',
    review: null,
    headSha: 'h1'
  }
}

function worker(dispatchId: string): BotWorkWorker {
  return {
    dispatchId,
    taskId: `task-${dispatchId}`,
    title: `work ${dispatchId}`,
    agent: 'claude',
    state: dispatchId === 'd-done' ? 'completed' : 'working',
    stopped: false,
    startFailed: false,
    host: 'local',
    hostName: null,
    worktreeId: `repo-1::/work/${dispatchId}`,
    startedAt: 1,
    settledAt: null
  }
}

describe('the work record through the bots DB worker', () => {
  const dirs: string[] = []
  const opened: { dispose: () => void }[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const store of opened.splice(0)) {
      store.dispose()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bot-work-parity-'))
    dirs.push(dir)
    return botWorkStoreFile(dir)
  }

  // The same starts, turns and reads against one store; what each read answers.
  async function reads(store: BotWorkRemote) {
    // Rows sort by when they were made: one tick per call, so neither run ties.
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1))
    const record = new BotWorkRecord({
      store: () => store,
      workers: async (ids) => new Map(ids.map((id) => [id, worker(id)])),
      // d-gone's workspace was deleted: its row closes on this read.
      workspaces: () => async (w) => (w.dispatchId === 'd-gone' ? 'gone' : { ...WORKSPACE }),
      conversationTitle: (address) => (address.source === 'chat' ? 'Home' : 'Slack thread'),
      turnAddress: async (sessionId) =>
        sessionId === 'slack-chat' ? { botId: 'bot-1', address: THREAD } : null
    })
    await record.started({ botId: 'bot-1', address: THREAD }, { ...start('d-old') })
    await record.started({ botId: 'bot-1', address: THREAD }, { ...start('d-slack') })
    await record.started({ botId: 'bot-1', address: CHAT, askedInApp: true }, start('d-done'))
    await record.started({ botId: 'bot-1', address: CHAT, askedInApp: true }, start('d-gone'))
    const list = await record.list('bot-1')
    return {
      // Row ids are random.
      list: list.map(({ id: _id, ...row }) => row),
      turnNote: await record.turnNote('slack-chat', { origin: 'connector' }),
      chatNote: await record.turnNote('home-chat', {}),
      liveWork: botActiveWorkSection([], list, { now: 10 }),
      pullRequests: await record.pullRequests('bot-1', THREAD, 3),
      rows: (await store.liveRows()).map(({ rowId: _id, createdAt: _at, ...row }) => row),
      forgotten: await record.forget('slack-chat'),
      afterForget: (await store.liveRows()).map((row) => row.dispatchId)
    }
  }

  it('answers the work list, turn note and live-work note exactly as the store in process', async () => {
    const path = storePath()
    let local: BotWorkStore | undefined
    const inProcess = await reads(inProcessBotWork(() => (local ??= BotWorkStore.open(path))))
    local?.dispose()
    const work = workerBotWork(storePath())
    opened.push(work)
    const viaWorker = await reads(work.store)

    expect(viaWorker).toEqual(inProcess)
    // The reads saw what they test: live rows, a closed one, notes and a PR.
    expect(viaWorker.list.map((row) => row.dispatchId)).toEqual(['d-done', 'd-slack', 'd-old'])
    expect(viaWorker.turnNote).toContain('dispatch:d-slack')
    expect(viaWorker.chatNote).toBeNull()
    expect(viaWorker.liveWork.text).toContain('dispatch:d-old working: "work d-old" · PR #12 open')
    expect(viaWorker.forgotten).toBe(true)
    expect(viaWorker.afterForget).toEqual(['d-done'])
  })

  it('records every one of several starts for one conversation that land at once', async () => {
    const work = workerBotWork(storePath())
    opened.push(work)
    const record = new BotWorkRecord({
      store: () => work.store,
      workers: async (ids) => new Map(ids.map((id) => [id, worker(id)])),
      workspaces: () => async () => null,
      conversationTitle: () => null,
      turnAddress: async () => null
    })
    const ids = ['d-1', 'd-2', 'd-3', 'd-4']
    await Promise.all(
      ids.map((id) => record.started({ botId: 'bot-1', address: THREAD }, start(id)))
    )
    // A start the reads saw again records nothing more.
    await record.started({ botId: 'bot-1', address: THREAD }, start('d-2'))

    const rows = await work.store.liveRows('bot-1')
    expect(rows.map((row) => row.dispatchId).sort()).toEqual(ids)
    expect(rows.filter((row) => row.current)).toHaveLength(1)
  })

  it('lists work as history once when it closes during the live listing', async () => {
    const work = workerBotWork(storePath())
    opened.push(work)
    await work.store.makeCurrent({ botId: 'bot-1', address: THREAD, ...start('d-live') }, 1)
    const closing = await work.store.makeCurrent(
      { botId: 'bot-1', address: CHAT, ...start('d-closing') },
      2
    )
    if (!closing) {
      throw new Error('The work to close was not recorded')
    }
    let stopped: Promise<boolean> | undefined
    const record = new BotWorkRecord({
      store: () => work.store,
      workers: async (ids) => new Map(ids.map((id) => [id, worker(id)])),
      workspaces: () => async () => null,
      conversationTitle: (address) => {
        if (address.source === 'chat') {
          stopped ??= work.store.close(closing, 'stopped', 3)
        }
        return null
      },
      turnAddress: async () => null
    })

    const list = await record.list('bot-1', true)

    expect(await stopped).toBe(true)
    expect(list.map(({ dispatchId, closedAt }) => [dispatchId, closedAt])).toEqual([
      ['d-live', undefined],
      ['d-closing', 3]
    ])
  })

  it('forgets newer closed work alongside a superseded live row in the same conversation', async () => {
    const work = workerBotWork(storePath())
    opened.push(work)
    const turn = { botId: 'bot-1', address: THREAD }
    await work.store.makeCurrent({ ...turn, ...start('d-old') }, 1)
    const newer = await work.store.makeCurrent({ ...turn, ...start('d-newer') }, 2)
    if (!newer) {
      throw new Error('The newer generation was not recorded')
    }
    await work.store.close(newer, 'stopped', 3)
    const other = await work.store.makeCurrent(
      { botId: 'bot-1', address: CHAT, ...start('d-other') },
      4
    )
    if (!other) {
      throw new Error('Work in the other conversation was not recorded')
    }
    await work.store.close(other, 'stopped', 5)
    const record = new BotWorkRecord({
      store: () => work.store,
      workers: async (ids) => new Map(ids.map((id) => [id, worker(id)])),
      workspaces: () => async () => null,
      conversationTitle: () => null,
      turnAddress: async () => turn
    })
    record.handedOver('slack-chat', { origin: 'connector' })

    expect(await record.forget('slack-chat')).toBe(true)
    expect((await record.list('bot-1', true)).map((row) => row.dispatchId)).toEqual(['d-other'])

    const later = await work.store.makeCurrent({ ...turn, ...start('d-later') }, 6)
    if (!later) {
      throw new Error('New work in the conversation was not recorded')
    }
    await work.store.close(later, 'stopped', 7)
    expect((await record.list('bot-1', true)).map((row) => row.dispatchId)).toEqual([
      'd-later',
      'd-other'
    ])
    expect(await record.forget('slack-chat')).toBe(true)
    expect((await record.list('bot-1', true)).map((row) => row.dispatchId)).toEqual(['d-other'])
  })
})

function start(dispatchId: string) {
  return { taskId: `task-${dispatchId}`, dispatchId, host: 'local' as const }
}
