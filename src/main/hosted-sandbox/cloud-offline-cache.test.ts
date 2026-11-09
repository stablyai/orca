import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCloudOfflineCache, OFFLINE_READ_METHODS, stableKey } from './cloud-offline-cache'
import {
  archiveCheckoutsFromCache,
  buildOfflineSnapshot,
  stripAnsi
} from './cloud-offline-snapshot'

const ok = (result: unknown) => ({
  id: 'x',
  ok: true as const,
  result,
  _meta: { runtimeId: 'rt-1' }
})

function setup(limits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-offline-'))
  let now = 1_000
  const cache = createCloudOfflineCache({ root, limits, now: () => now, flushDelayMs: 0 })
  return { root, cache, tick: (ms = 1) => (now += ms) }
}

describe('cloud offline cache', () => {
  it('keeps only allowlisted read-only methods', () => {
    const { cache } = setup()
    cache.record('env', 'git.status', { worktree: 'id:w' }, ok({ entries: [] }))
    cache.record('env', 'agentSession.send', { sessionId: 's' }, ok({}))
    cache.record('env', 'git.commit', { worktree: 'id:w' }, ok({}))
    expect(cache.entries('env').map((e) => e.method)).toEqual(['git.status'])
    expect(OFFLINE_READ_METHODS.has('terminal.send')).toBe(false)
    expect(cache.lookup('env', 'agentSession.send', { sessionId: 's' })).toBeNull()
  })

  it('looks up by params regardless of key order and survives a reload from disk', () => {
    const { root, cache } = setup()
    cache.record('env', 'git.history', { worktree: 'id:w', limit: 20 }, ok({ items: [1] }))
    expect(stableKey('m', { a: 1, b: 2 })).toBe(stableKey('m', { b: 2, a: 1 }))
    const reloaded = createCloudOfflineCache({ root, flushDelayMs: 0 })
    expect(reloaded.lookup('env', 'git.history', { limit: 20, worktree: 'id:w' })?.result).toEqual({
      items: [1]
    })
    expect(readdirSync(root).every((name) => !name.includes('env'))).toBe(true)
  })

  it('evicts the oldest entries past the per-workspace bound and refuses oversized answers', () => {
    const { cache, tick } = setup({ maxEntriesPerEnvironment: 3, maxEntryBytes: 200 })
    for (let i = 0; i < 5; i++) {
      tick()
      cache.record('env', 'terminal.read', { terminal: `t${i}` }, ok({ tail: ['x'] }))
    }
    expect(
      cache
        .entries('env')
        .map((e) => (e.params as { terminal: string }).terminal)
        .sort()
    ).toEqual(['t2', 't3', 't4'])
    cache.record('env', 'terminal.read', { terminal: 't4' }, ok({ tail: ['y'.repeat(500)] }))
    // The stale smaller answer is dropped rather than served as current.
    expect(cache.lookup('env', 'terminal.read', { terminal: 't4' })).toBeNull()
  })

  it('evicts whole least-recent workspaces past the total bound, and prunes removed ones', () => {
    const { root, cache, tick } = setup({ maxTotalBytes: 900 })
    for (const env of ['a', 'b', 'c']) {
      tick(1000)
      cache.record(env, 'git.status', { worktree: env }, ok({ entries: ['z'.repeat(300)] }))
    }
    expect(readdirSync(root).filter((n) => n.endsWith('.json')).length).toBeLessThan(3)
    expect(cache.lookup('c', 'git.status', { worktree: 'c' })).not.toBeNull()
    cache.prune(new Set(['c']))
    expect(readdirSync(root).filter((n) => n.endsWith('.json'))).toHaveLength(1)
    cache.forget('c')
    expect(readdirSync(root).filter((n) => n.endsWith('.json'))).toHaveLength(0)
  })

  it('writes owner-only files', () => {
    const { root, cache } = setup()
    cache.record('env', 'git.status', {}, ok({}))
    const [name] = readdirSync(root)
    expect(JSON.parse(readFileSync(join(root, name!), 'utf8')).environmentId).toBe('env')
  })
})

describe('offline snapshot', () => {
  it('builds chats, terminals and git state from cached answers', () => {
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
      ok({ handle: 'h1', tail: ['\u001b[32mready\u001b[0m on :3000'] })
    )
    cache.record(
      'env',
      'git.status',
      { worktree: 'id:w' },
      ok({
        branch: 'feat',
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
    const snapshot = buildOfflineSnapshot(cache, 'env', 'w', true)
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
    const [checkout] = archiveCheckoutsFromCache(cache, 'env', '/vercel/sandbox/project')!
    expect(checkout).toMatchObject({
      branch: 'feat',
      head: 'abcdef1',
      changes: [{ status: 'M', path: 'a.ts' }]
    })
  })

  it('strips terminal escapes', () => {
    expect(stripAnsi('\u001b]0;title\u0007a\u001b[1;31mb\u001b[0m\rc')).toBe('abc')
  })
})
