import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { openNostrRelaySession, NostrRelaysUnreachableError } from './nostr-relay-session'
import { readNostrRepositorySnapshot } from './repository-snapshot'
import { startLocalNostrRelay, testAuthor } from './local-nostr-relay.test-fixture'

const owner = testAuthor(1)
const coMaintainer = testAuthor(2)
const contributor = testAuthor(3)
const stranger = testAuthor(4)

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('ngit repository snapshot', () => {
  it('applies status, subject, tip and deletion only from the people allowed to', async () => {
    const coordinate = `30617:${owner.pubkey}:demo`
    const announcement = owner.sign(30617, [
      ['d', 'demo'],
      ['maintainers', owner.pubkey, coMaintainer.pubkey]
    ])
    const issue = contributor.sign(
      1621,
      [
        ['a', coordinate],
        ['subject', 'Splicing']
      ],
      'body'
    )
    const pull = contributor.sign(1618, [
      ['a', coordinate],
      ['subject', 'Add splicing'],
      ['branch-name', 'splicing'],
      ['c', 'a'.repeat(40)]
    ])
    const deleted = contributor.sign(1621, [
      ['a', coordinate],
      ['subject', 'Gone']
    ])
    const events = [
      announcement,
      issue,
      pull,
      deleted,
      contributor.sign(5, [['e', deleted.id]]),
      // A stranger may neither delete, close, retitle nor move any of these.
      stranger.sign(5, [['e', issue.id]]),
      stranger.sign(1632, [['e', issue.id]], '', 3_000),
      stranger.sign(1985, [
        ['e', issue.id],
        ['L', '#subject'],
        ['l', 'Spam', '#subject']
      ]),
      stranger.sign(
        1619,
        [
          ['E', pull.id],
          ['c', 'f'.repeat(40)]
        ],
        '',
        3_000
      ),
      // A co-maintainer's newest status wins over an older one.
      coMaintainer.sign(1632, [['e', pull.id]], '', 1_500),
      coMaintainer.sign(1631, [['e', pull.id]], '', 2_000),
      contributor.sign(
        1619,
        [
          ['E', pull.id],
          ['c', 'b'.repeat(40)]
        ],
        '',
        1_200
      ),
      stranger.sign(
        1111,
        [
          ['E', issue.id],
          ['e', issue.id]
        ],
        'a comment',
        1_100
      )
    ]
    const relay = await startLocalNostrRelay(events)
    const session = openNostrRelaySession()
    closers.push(relay.close, session.close)

    const snapshot = await readNostrRepositorySnapshot(session.query, owner.pubkey, 'demo', [
      relay.url
    ])
    // Only the local relay is read; the announced relay list is empty.
    const items = snapshot!.items.map(({ item }) => item)

    expect(items.map((item) => item.title).sort()).toEqual(['Add splicing', 'Splicing'])
    expect(items.find((item) => item.type === 'issue')).toMatchObject({
      state: 'open',
      commentCount: 1,
      number: Number.parseInt(issue.id.slice(0, 8), 16)
    })
    expect(items.find((item) => item.type === 'pr')).toMatchObject({
      state: 'merged',
      headSha: 'b'.repeat(40),
      branchName: 'splicing'
    })
  })

  it('orders a patch series by parentage and follows its newest revision', async () => {
    const coordinate = `30617:${owner.pubkey}:demo`
    const patch = (tags: string[][], commit: string, parent: string, createdAt: number) =>
      contributor.sign(
        1617,
        [['a', coordinate], ['commit', commit], ['parent-commit', parent], ...tags],
        `From ${commit}\nSubject: [PATCH] step ${commit}\n\n---\n`,
        createdAt
      )
    const root = patch([['t', 'root']], 'c1', 'base', 100)
    const revision = patch(
      [
        ['t', 'root'],
        ['t', 'root-revision'],
        ['e', root.id]
      ],
      'd1',
      'base',
      200
    )
    // Same second as its parent, as one `ngit send` produces.
    const second = patch([['e', revision.id]], 'd2', 'd1', 200)
    const relay = await startLocalNostrRelay([
      owner.sign(30617, [['d', 'demo']]),
      root,
      revision,
      second
    ])
    const session = openNostrRelaySession()
    closers.push(relay.close, session.close)

    const snapshot = await readNostrRepositorySnapshot(session.query, owner.pubkey, 'demo', [
      relay.url
    ])

    expect(snapshot!.items).toHaveLength(1)
    expect(snapshot!.items[0].patches.map((p) => p.commit)).toEqual(['d1', 'd2'])
    expect(snapshot!.items[0].item).toMatchObject({ headSha: 'd2', title: 'step c1' })
  })

  it('drops forged and unrequested events, and fails rather than reporting empty', async () => {
    const genuine = owner.sign(1621, [['subject', 'real']])
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the only client is the session under test.
        const [type, subscription] = JSON.parse(String(data)) as [string, string]
        if (type !== 'REQ') {
          return
        }
        for (const event of [
          genuine,
          { ...genuine, content: 'tampered' },
          owner.sign(1, [], 'unrequested')
        ]) {
          socket.send(JSON.stringify(['EVENT', subscription, event]))
        }
        socket.send(JSON.stringify(['EOSE', subscription]))
      })
    )
    await new Promise<void>((resolve) => server.once('listening', resolve))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a listening TCP server has an AddressInfo.
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    const session = openNostrRelaySession()
    closers.push(session.close, () => new Promise<void>((done) => server.close(() => done())))

    await expect(session.query([url], [{ kinds: [1621] }])).resolves.toEqual([
      expect.objectContaining({ id: genuine.id, content: '' })
    ])
    await expect(session.query(['ws://127.0.0.1:1'], [{ kinds: [1621] }])).rejects.toThrow(
      NostrRelaysUnreachableError
    )
    await expect(session.query(['http://example.invalid'], [{}])).rejects.toThrow(
      NostrRelaysUnreachableError
    )
  })
})
