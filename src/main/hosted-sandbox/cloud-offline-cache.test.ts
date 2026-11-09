import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCloudOfflineCache,
  OFFLINE_READ_METHODS,
  stableKey,
  type OfflineCacheCodec
} from './cloud-offline-cache'
import {
  archiveCheckoutsFromCache,
  buildOfflineSnapshot,
  stringParam,
  stripAnsi
} from './cloud-offline-snapshot'

const ok = (result: unknown) => ({
  id: 'x',
  ok: true as const,
  result,
  _meta: { runtimeId: 'rt-1' }
})

/** Stand-in for safeStorage: reversible, and never the plaintext. */
export const testCodec: OfflineCacheCodec = {
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (sealed) => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString('utf8')
}

function setup(limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-offline-'))
  let now = 1_000
  const cache = createCloudOfflineCache({
    root,
    codec: testCodec,
    limits: { minRecordIntervalMs: 0, ...limits },
    now: () => now,
    flushDelayMs: 0
  })
  return { root, cache, tick: (ms = 1) => (now += ms) }
}

describe('cloud offline cache', () => {
  it('keeps only allowlisted read-only methods', async () => {
    const { cache } = setup()
    cache.record('env', 'git.status', { worktree: 'id:w' }, ok({ entries: [] }))
    cache.record('env', 'agentSession.send', { sessionId: 's' }, ok({}))
    cache.record('env', 'git.commit', { worktree: 'id:w' }, ok({}))
    expect((await cache.entries('env')).map((e) => e.method)).toEqual(['git.status'])
    expect(OFFLINE_READ_METHODS.has('terminal.send')).toBe(false)
    expect(await cache.lookup('env', 'agentSession.send', { sessionId: 's' })).toBeNull()
  })

  it('seals files at rest and reads them back after a reload', async () => {
    const { root, cache } = setup()
    cache.record(
      'env',
      'git.history',
      { worktree: 'id:w', limit: 20 },
      ok({ items: ['secret subject'] })
    )
    expect(stableKey('m', { a: 1, b: 2 })).toBe(stableKey('m', { b: 2, a: 1 }))
    await cache.flush()
    const [name] = readdirSync(root)
    expect(readFileSync(join(root, name!)).toString('utf8')).not.toContain('secret subject')
    const reloaded = createCloudOfflineCache({ root, codec: testCodec, flushDelayMs: 0 })
    expect(
      (await reloaded.lookup('env', 'git.history', { limit: 20, worktree: 'id:w' }))?.result
    ).toEqual({
      items: ['secret subject']
    })
  })

  it('keeps nothing when the OS cannot seal files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-offline-'))
    const cache = createCloudOfflineCache({ root, codec: null, flushDelayMs: 0 })
    cache.record('env', 'git.status', {}, ok({ entries: [] }))
    expect(await cache.entries('env')).toEqual([])
    await cache.flush()
    expect(readdirSync(root)).toEqual([])
  })

  it('does not re-serialize a key polled again within the interval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-offline-'))
    let now = 0
    const cache = createCloudOfflineCache({
      root,
      codec: testCodec,
      now: () => now,
      flushDelayMs: 0
    })
    cache.record('env', 'terminal.read', { terminal: 't' }, ok({ terminal: { tail: ['a'] } }))
    now = 1_000
    cache.record('env', 'terminal.read', { terminal: 't' }, ok({ terminal: { tail: ['b'] } }))
    expect((await cache.lookup('env', 'terminal.read', { terminal: 't' }))?.result).toEqual({
      terminal: { tail: ['a'] }
    })
    now = 6_000
    cache.record('env', 'terminal.read', { terminal: 't' }, ok({ terminal: { tail: ['c'] } }))
    expect((await cache.lookup('env', 'terminal.read', { terminal: 't' }))?.result).toEqual({
      terminal: { tail: ['c'] }
    })
  })

  it('evicts the oldest entries past the per-workspace bound and refuses oversized answers', async () => {
    const { cache, tick } = setup({ maxEntriesPerEnvironment: 3, maxEntryBytes: 200 })
    for (let i = 0; i < 5; i++) {
      tick()
      cache.record('env', 'terminal.read', { terminal: `t${i}` }, ok({ terminal: { tail: ['x'] } }))
    }
    expect(
      (await cache.entries('env')).map((e) => stringParam(e.params, 'terminal')).sort()
    ).toEqual(['t2', 't3', 't4'])
    cache.record(
      'env',
      'terminal.read',
      { terminal: 't4' },
      ok({ terminal: { tail: ['y'.repeat(500)] } })
    )
    expect(await cache.lookup('env', 'terminal.read', { terminal: 't4' })).toBeNull()
  })

  it('holds a bounded number of workspaces in memory and still reads evicted ones from disk', async () => {
    const { cache, tick } = setup({ maxLoadedEnvironments: 2 })
    for (const env of ['a', 'b', 'c', 'd']) {
      tick()
      cache.record(env, 'git.status', { worktree: env }, ok({ branch: env }))
    }
    expect((await cache.lookup('a', 'git.status', { worktree: 'a' }))?.result).toEqual({
      branch: 'a'
    })
  })

  it('evicts whole least-recent workspaces past the total bound, prunes removed ones, and clears on sign-out', async () => {
    const { root, cache, tick } = setup({ maxTotalBytes: 900 })
    for (const env of ['a', 'b', 'c']) {
      tick(1000)
      cache.record(env, 'git.status', { worktree: env }, ok({ entries: ['z'.repeat(300)] }))
    }
    await cache.flush()
    expect(readdirSync(root).length).toBeLessThan(3)
    expect(await cache.lookup('c', 'git.status', { worktree: 'c' })).not.toBeNull()
    await cache.prune(new Set(['c']))
    expect(readdirSync(root)).toHaveLength(1)
    await cache.clear()
    expect(existsSync(root)).toBe(false)
    expect(await cache.lookup('c', 'git.status', { worktree: 'c' })).toBeNull()
  })
})

describe('legacy plaintext cache files', () => {
  it('are removed whatever the codec', async () => {
    for (const sealing of [testCodec, null]) {
      const root = mkdtempSync(join(tmpdir(), 'orca-offline-'))
      writeFileSync(
        join(root, 'abc.json'),
        '{"version":1,"entries":{"k":{"result":"old plaintext"}}}'
      )
      await createCloudOfflineCache({ root, codec: sealing, flushDelayMs: 0 }).flush()
      expect(readdirSync(root)).toEqual([])
    }
  })
})

describe('offline snapshot', () => {
  it('builds chats, terminals and git state from cached answers', async () => {
    const { cache, tick } = setup()
    cache.record(
      'env',
      'terminal.list',
      { worktree: 'id:w' },
      ok({ terminals: [{ handle: 'h1', title: 'zsh', paneTitle: 'Dev server' }] })
    )
    cache.record(
      'env',
      'terminal.read',
      { terminal: 'h1', limit: 400 },
      ok({ terminal: { handle: 'h1', tail: ['\u001b[32mready\u001b[0m on :3000'] } })
    )
    cache.record(
      'env',
      'git.status',
      { worktree: 'id:w' },
      ok({
        branch: 'refs/heads/feat',
        head: 'abcdef1',
        entries: [{ path: 'a.ts', status: 'modified', area: 'unstaged' }]
      })
    )
    cache.record(
      'env',
      'git.history',
      { worktree: 'id:w', limit: 20 },
      ok({ items: [{ id: 'abcdef1', subject: 'Add a', author: 'Ada', timestamp: 5 }] })
    )
    tick()
    cache.record(
      'env',
      'agentSession.history',
      { sessionId: 's1', direction: 'tail', limit: 200 },
      ok({
        ok: true,
        page: {
          sessionId: 's1',
          items: [
            {
              itemId: 'i1',
              observedAt: 1,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'fix the bug' }]
              }
            },
            { itemId: 'i2', observedAt: 2, body: { kind: 'tool-call', name: 'Bash' } },
            {
              itemId: 'i3',
              observedAt: 3,
              body: {
                kind: 'message',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'Done.' }]
              }
            }
          ]
        }
      })
    )
    const snapshot = await buildOfflineSnapshot(cache, 'env', 'w', true)
    expect(snapshot.asleep).toBe(true)
    expect(snapshot.terminals).toEqual([
      { handle: 'h1', title: 'Dev server', lines: ['ready on :3000'], at: 1000 }
    ])
    expect(snapshot.git).toMatchObject({
      branch: 'feat',
      changeCount: 1,
      commits: [{ id: 'abcdef1', subject: 'Add a' }]
    })
    expect(snapshot.chats[0]!.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'fix the bug'],
      ['assistant', 'Done.']
    ])
    expect(snapshot.capturedAt).toBe(1001)
    const [checkout] =
      (await archiveCheckoutsFromCache(cache, 'env', '/vercel/sandbox/project')) ?? []
    expect(checkout).toMatchObject({
      branch: 'feat',
      head: 'abcdef1',
      changes: [{ status: 'M', path: 'a.ts' }]
    })
  })

  it('strips terminal escapes', async () => {
    expect(stripAnsi('\u001b]0;title\u0007a\u001b[1;31mb\u001b[0m\rc')).toBe('abc')
  })
})
