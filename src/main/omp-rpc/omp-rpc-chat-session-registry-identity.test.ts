import { afterEach, describe, expect, it } from 'vitest'
import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function makeRegistry(
  scenario: Partial<Parameters<typeof createFakeOmpRpcChild>[0]> = {},
  dependencies: Omit<
    NonNullable<ConstructorParameters<typeof OmpRpcChatSessionRegistry>[0]>,
    'spawnClient'
  > = {}
): OmpRpcChatSessionRegistry {
  return new OmpRpcChatSessionRegistry({
    ...dependencies,
    spawnClient: () => {
      const client = spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            ...scenario,
            sessionState: {
              sessionFile: null,
              sessionId: 'session-a',
              isStreaming: false,
              isCompacting: false,
              queuedMessageCount: 0
            }
          },
          'session-owning'
        ).spawnOptions
      ) as unknown as OmpSessionOwningRpcClient
      clients.add(client)
      return client
    }
  })
}

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry session identity ownership', () => {
  // XLR-036 (cross-lab review): an unreadable post-command identity is no proof
  // the child left the session it acquired, so retirement may not hand that
  // session back to the pool on a SIGTERM alone — the claim and the exclusion
  // both have to outlive the signal, until the exit itself is proven.
  it('holds an unreadably-retired session until its child exits (XLR-036)', async () => {
    const registry = makeRegistry(
      { promptSessionChange: { sessionFile: null } },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    await registry.acquire({
      paneKey: 'tab:leaf-a',
      ptyId: 'pty-a',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    // The command runs, but the identity read-back comes back empty: this
    // registry can no longer prove which session the child is writing.
    await expect(
      registry.get('tab:leaf-a')?.send({ message: '/branch', behavior: 'command' })
    ).resolves.toMatchObject({ ok: false })

    expect(registry.get('tab:leaf-a')).toBeNull()
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/a.jsonl'])
    )
    const second = await registry.acquire({
      paneKey: 'other:pane',
      ptyId: 'pty-b',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    expect(second.status).toBe('conflict')
  })

  // Wave 9, Defect 2, acceptance criteria 3 & 4: the exclusion set for the
  // mtime fallback must consider only claims held by panes OTHER than the
  // asking pane — the asking pane's own claim must never be held against
  // it, while a genuinely different pane's claim must still be excluded.
  describe('claimedSessionFilePathsExcluding', () => {
    it("excludes only OTHER panes' claims, never the asking pane's own", async () => {
      const registry = makeRegistry()
      await registry.acquire({
        paneKey: 'tab:leaf-a',
        ptyId: 'pty-a',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/a.jsonl',
        sessionFilePath: '/sessions/a.jsonl',
        isPtyAlive: () => false
      })
      await registry.acquire({
        paneKey: 'tab:leaf-b',
        ptyId: 'pty-b',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/b.jsonl',
        sessionFilePath: '/sessions/b.jsonl',
        isPtyAlive: () => false
      })

      // Pane A re-resolving its own identity: its own claim must not be in
      // the exclusion set, but pane B's must (finding C intact).
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-a')).toEqual(
        new Set(['/sessions/b.jsonl'])
      )
      // Pane B symmetrically excludes only A's claim.
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-b')).toEqual(
        new Set(['/sessions/a.jsonl'])
      )
      // A pane with no claim of its own (e.g. a fresh third pane sharing
      // the cwd bucket) still sees every currently-claimed path excluded.
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-c')).toEqual(
        new Set(['/sessions/a.jsonl', '/sessions/b.jsonl'])
      )
    })

    it("drops a pane's exclusion entry once it releases (no leak, none to 'fix')", async () => {
      const registry = makeRegistry()
      await registry.acquire({
        paneKey: 'tab:leaf-a',
        ptyId: 'pty-a',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/a.jsonl',
        sessionFilePath: '/sessions/a.jsonl',
        isPtyAlive: () => false
      })
      await registry.release('tab:leaf-a')
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-b')).toEqual(new Set())
    })
  })
})
