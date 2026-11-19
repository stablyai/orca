import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAccessRequest } from '../../shared/bots/bot-access-request.test-fixture'
import type { ConnectorAccessRequest } from '../../shared/connector-bot-access-contract'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { OwnerNotice } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { makeTestBot } from './bot.test-fixture'
import { fakeAccessCloud } from './bot-access-cloud.test-fixture'
import {
  botAccessSeenFile,
  createBotAccessRequestWatch,
  type BotAccessSeen,
  type BotAccessSeenStore,
  type BotAccessWatchDeps
} from './bot-access-request-watch'

const bot = makeTestBot({
  name: 'Scout',
  folderWorkspaceId: 'fw-scout',
  chatSessionId: 'home-chat',
  slack: { appId: 'A1', teamId: 'T1' }
})
const dirs: string[] = []

function profileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bot-access-watch-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const MINUTE = 60_000
// The host's clock, after every stamp the tests make unless they say otherwise.
const HOST_NOW = 60 * MINUTE
let clock = 0
afterEach(() => {
  clock = 0
})
/** A request the cloud stamps after every earlier one, unless `createdAt` is given. */
const request = (requestId: string, createdAt = ++clock) =>
  makeAccessRequest({ requestId, createdAt, expiresAt: createdAt + 100 })

/** A host whose cloud lists `listed` (mutable, as the cloud's window moves); a new host is a restart. */
function host(
  seen: BotAccessSeenStore,
  listed: ConnectorAccessRequest[],
  overrides: Partial<BotAccessWatchDeps> = {}
) {
  const sent: OwnerNotice[] = []
  const changed = vi.fn()
  const watch = createBotAccessRequestWatch({
    bots: () => [bot],
    cloud: () => fakeAccessCloud(listed).cloud,
    updateBot: async () => bot,
    botsEnabled: () => true,
    notify: (notice) => sent.push(notice),
    changed,
    seen,
    now: () => HOST_NOW,
    ...overrides
  })
  const pushedIds = () => sent.map((notice) => notice.id)
  return { watch, sent, changed, pushedIds }
}

describe('the access request watch', () => {
  it('records what waits on a first read, then announces each new request once, to phones and the window', async () => {
    const listed = [request('old')]
    const { watch, sent } = host(botAccessSeenFile(profileDir()), listed)

    await watch.tick()
    listed.push(request('new'))
    await watch.tick()
    await watch.tick()

    expect(sent).toEqual([
      {
        id: 'bot-access-request:new',
        title: 'Dana Kim asked to use Scout',
        body: 'Slack · Acme',
        worktreeId: 'folder:fw-scout',
        paneKey: structuredAgentSessionStatusPaneKey('home-chat'),
        // The window toasts it itself.
        desktop: false
      }
    ])
  })

  it('does not announce again after a restart', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    await host(seen, listed).watch.tick()
    listed.push(request('r1'))
    const before = host(seen, listed)
    await before.watch.tick()
    const afterRestart = host(seen, listed)
    await afterRestart.watch.tick()

    expect(before.pushedIds()).toEqual(['bot-access-request:r1'])
    expect(afterRestart.sent).toEqual([])
  })

  it('never announces a waiting request again once it falls out of the capped list and comes back, across a restart', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    const first = host(seen, listed)
    await first.watch.tick()
    const r1 = request('r1')
    listed.push(r1)
    await first.watch.tick()
    // 100 newer requests push r1, still waiting, out of the cloud's newest-100 window.
    const newer = Array.from({ length: 100 }, (_, i) => request(`n${i}`))
    listed.splice(0, listed.length, ...newer)
    await first.watch.tick()
    listed.splice(0, listed.length, r1, ...newer.slice(1))
    await first.watch.tick()
    const restarted = host(seen, listed)
    await restarted.watch.tick()

    expect(first.pushedIds().filter((id) => id === 'bot-access-request:r1')).toHaveLength(1)
    expect(first.pushedIds()).toHaveLength(101)
    expect(restarted.sent).toEqual([])
  })

  it('pushes a request saved late with an earlier stamp exactly once, across a restart', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    await host(seen, listed).watch.tick()
    listed.push(request('newer', 10 * MINUTE))
    const first = host(seen, listed)
    await first.watch.tick()
    // Another cloud server stamped it 2 minutes earlier but saved it after that read.
    listed.push(request('late', 8 * MINUTE))
    await first.watch.tick()
    await first.watch.tick()
    const restarted = host(seen, listed)
    await restarted.watch.tick()

    expect(first.pushedIds()).toEqual(['bot-access-request:newer', 'bot-access-request:late'])
    expect(restarted.sent).toEqual([])
  })

  it('keeps an announced id only while it is inside the lookback, and never announces an older one', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    await host(seen, listed).watch.tick()
    const old = request('old', MINUTE)
    listed.push(old)
    const first = host(seen, listed)
    await first.watch.tick()
    listed.splice(0, listed.length, request('later', 20 * MINUTE))
    await first.watch.tick()
    // Back in the capped list, and older than the lookback.
    listed.push(old)
    await first.watch.tick()

    expect(seen.read()).toEqual({ through: 20 * MINUTE, recent: [['later', 20 * MINUTE]] })
    expect(first.pushedIds()).toEqual(['bot-access-request:old', 'bot-access-request:later'])
  })

  it('marks what already waits on a first read, with no backlog', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed = [request('old-1'), request('old-2')]
    const first = host(seen, listed)
    await first.watch.tick()

    expect(first.sent).toEqual([])
    expect(seen.read()).toEqual({
      through: 2,
      recent: [
        ['old-2', 2],
        ['old-1', 1]
      ]
    })
  })

  it('does not announce again when the record cannot be saved, and saves it once it can', async () => {
    let saved: BotAccessSeen | null = { through: 0, recent: [] }
    const write = vi.fn((next: BotAccessSeen) => {
      if (write.mock.calls.length <= 2) {
        throw new Error('EACCES')
      }
      saved = next
    })
    const seen: BotAccessSeenStore = { read: () => saved, write }
    const listed = [request('r1')]
    const { watch, pushedIds } = host(seen, listed)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watch.tick()
    await watch.tick()
    await watch.tick()

    expect(pushedIds()).toEqual(['bot-access-request:r1'])
    expect(saved).toEqual({ through: 1, recent: [['r1', 1]] })
  })

  it('announces again at most once when a restart comes while saves keep failing', async () => {
    const write = vi.fn(() => {
      throw new Error('EACCES')
    })
    const seen: BotAccessSeenStore = { read: () => ({ through: 0, recent: [] }), write }
    const listed = [request('r1')]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = host(seen, listed)
    await before.watch.tick()
    await before.watch.tick()
    const restarted = host(seen, listed)
    await restarted.watch.tick()
    await restarted.watch.tick()

    expect(before.pushedIds()).toEqual(['bot-access-request:r1'])
    expect(restarted.pushedIds()).toEqual(['bot-access-request:r1'])
  })

  it('lets a stamp from far in the future move the mark no further than the lookback', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    await host(seen, listed).watch.tick()
    listed.push(request('future', HOST_NOW + 10 * 365 * 24 * 60 * MINUTE))
    const first = host(seen, listed)
    await first.watch.tick()
    listed.push(request('next', HOST_NOW + MINUTE))
    await first.watch.tick()
    const restarted = host(seen, listed)
    await restarted.watch.tick()
    listed.push(request('after-restart', HOST_NOW + 2 * MINUTE))
    await restarted.watch.tick()

    expect(first.pushedIds()).toEqual(['bot-access-request:future', 'bot-access-request:next'])
    expect(restarted.pushedIds()).toEqual(['bot-access-request:after-restart'])
  })

  it.each([
    ['an overflowed mark', '{"through":1e309,"recent":[]}'],
    ['a mark past the clock', JSON.stringify({ through: HOST_NOW + 10 * MINUTE, recent: [] })],
    [
      'too many ids',
      JSON.stringify({
        through: 1,
        recent: Array.from({ length: 501 }, (_, i) => [`r${i}`, 1])
      })
    ],
    ['an overlong id', JSON.stringify({ through: 1, recent: [['r'.repeat(129), 1]] })]
  ])('starts over from what waits, with no backlog, on %s', async (_label, record) => {
    const dir = profileDir()
    writeFileSync(join(dir, 'bot-access-requests-seen.json'), record)
    const seen = botAccessSeenFile(dir)
    const listed = [request('waiting')]
    const first = host(seen, listed)
    await first.watch.tick()
    listed.push(request('new'))
    await first.watch.tick()

    expect(first.pushedIds()).toEqual(['bot-access-request:new'])
  })

  it('announces a request listed twice in one read once', async () => {
    const seen = botAccessSeenFile(profileDir())
    const listed: ConnectorAccessRequest[] = []
    const { watch, pushedIds } = host(seen, listed)
    await watch.tick()
    const twice = request('twice')
    listed.push(twice, twice)
    await watch.tick()

    expect(pushedIds()).toEqual(['bot-access-request:twice'])
    expect(seen.read()?.recent).toEqual([['twice', twice.createdAt]])
  })

  it('runs one read at a time', async () => {
    const listed = [request('r1')]
    const { watch, sent } = host(
      { read: () => ({ through: 0, recent: [] }), write: () => {} },
      listed
    )

    await Promise.all([watch.tick(), watch.tick()])

    expect(sent).toHaveLength(1)
  })

  it('tells windows and phones once per change to the waiting list, not per read', async () => {
    const listed = [request('r1')]
    const { watch, changed } = host(botAccessSeenFile(profileDir()), listed)

    await watch.tick()
    await watch.tick()
    expect(changed).toHaveBeenCalledOnce()
    listed.push(request('r2'))
    await watch.tick()
    await watch.tick()
    expect(changed).toHaveBeenCalledTimes(2)
    // Answered elsewhere: it leaves the list.
    listed.splice(0, 1)
    await watch.tick()
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('serves the list from its last read, so botsChanged re-reads cost no cloud call', async () => {
    const fake = fakeAccessCloud([request('r1')])
    const { watch } = host(botAccessSeenFile(profileDir()), [], { cloud: () => fake.cloud })

    await watch.tick()
    const lists = await Promise.all(Array.from({ length: 5 }, () => watch.list()))

    expect(fake.call).toHaveBeenCalledOnce()
    expect(lists.every((listed) => listed.ok && listed.value[0]?.requestId === 'r1')).toBe(true)
  })

  it('reads the cloud once for lists asked for before its first read', async () => {
    const fake = fakeAccessCloud([request('r1')])
    const { watch } = host(botAccessSeenFile(profileDir()), [], { cloud: () => fake.cloud })

    const [first, second] = await Promise.all([watch.list(), watch.list()])

    expect(fake.call).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
    expect(first.ok && first.value.map((entry) => entry.requestId)).toEqual(['r1'])
  })

  it('drops an answered request at once, then reads the cloud once more', async () => {
    const fake = fakeAccessCloud([request('r1'), request('r2')])
    const { watch, changed } = host(botAccessSeenFile(profileDir()), [], {
      cloud: () => fake.cloud
    })
    await watch.tick()
    // The decision as the cloud saves it.
    await fake.call('/v1/access-requests/r1/decision', { decision: 'declined' })
    const reads = fake.call.mock.calls.length

    const answered = watch.answered('r1')
    const now = await watch.list()
    await answered

    expect(now.ok && now.value.map((entry) => entry.requestId)).toEqual(['r2'])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(fake.call.mock.calls.length).toBe(reads + 1)
  })

  it('drops requests it read once no bot is on a connector', async () => {
    let bots = [bot]
    const { watch, changed } = host(botAccessSeenFile(profileDir()), [request('r1')], {
      bots: () => bots
    })
    await watch.tick()
    expect(changed).toHaveBeenCalledTimes(1)
    bots = [makeTestBot({ id: 'home', name: 'Home', folderWorkspaceId: 'fw-home' })]
    await watch.tick()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('reads the cloud only while a bot is on a connector', async () => {
    const homeOnly = makeTestBot({ id: 'home', name: 'Home', folderWorkspaceId: 'fw-home' })
    const reads = (bots: ReturnType<typeof makeTestBot>[]) => {
      const fake = fakeAccessCloud([request('r1')])
      const { watch } = host(botAccessSeenFile(profileDir()), [], {
        bots: () => bots,
        cloud: () => fake.cloud
      })
      return { watch, fake }
    }
    const off = reads([homeOnly])
    await off.watch.tick()
    expect(off.fake.call).not.toHaveBeenCalled()

    for (const connected of [
      { slack: { appId: 'A1', teamId: 'T1' } },
      { linear: { workspaceId: 'L1', workspaceName: 'Acme' } },
      { github: {} }
    ]) {
      const on = reads([
        homeOnly,
        makeTestBot({ id: 'on', name: 'On', folderWorkspaceId: 'fw-on', ...connected })
      ])
      await on.watch.tick()
      expect(on.fake.call).toHaveBeenCalledTimes(1)
    }
  })

  it('lists none without a cloud call when no bot is on a connector, however often it is asked', async () => {
    const fake = fakeAccessCloud([request('r1')])
    const homeOnly = makeTestBot({ id: 'home', name: 'Home', folderWorkspaceId: 'fw-home' })
    const { watch } = host(botAccessSeenFile(profileDir()), [], {
      bots: () => [homeOnly],
      cloud: () => fake.cloud
    })

    // Every launch and every botsChanged asks for the list.
    const lists = await Promise.all(Array.from({ length: 3 }, () => watch.list()))

    expect(fake.call).not.toHaveBeenCalled()
    expect(lists).toEqual(Array.from({ length: 3 }, () => ({ ok: true, value: [] })))
  })

  it("announces nothing for another host's bot, or while bots are off", async () => {
    const seen = botAccessSeenFile(profileDir())
    await host(seen, []).watch.tick()
    const otherHost = host(seen, [makeAccessRequest({ botId: 'elsewhere', createdAt: 1 })])
    await otherHost.watch.tick()
    const off = host(seen, [request('r1')], { botsEnabled: () => false })
    await off.watch.tick()

    expect(otherHost.sent).toEqual([])
    expect(off.sent).toEqual([])
    expect(off.changed).not.toHaveBeenCalled()
  })
})
