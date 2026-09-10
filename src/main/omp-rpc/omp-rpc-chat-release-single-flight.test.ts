// Concurrent releases of ONE pane: cleanup and a reclaiming acquire routinely
// ask at the same time, and there is only ever one child to hand back. Split
// from omp-rpc-chat-session-registry.ts's own test file so neither exceeds its
// max-lines budget.

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

describe('OmpRpcChatSessionRegistry release single-flight', () => {
  // XLR-046 (cross-lab review): cleanup and a reclaiming acquire routinely ask
  // to release the same pane at once. A second release ran its own
  // `handoffToPty` against the child the first was already disposing, and both
  // shared one uncounted "releasing" flag — so whichever finished first
  // re-admitted command surfaces while the other release was still live.
  it('joins a release already in flight instead of starting a second one (XLR-046)', async () => {
    let exitProofs = 0
    const registry = makeRegistry(
      {},
      {
        proveRpcExit: async () => {
          exitProofs += 1
          return { status: 'exited' }
        }
      }
    )
    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    const [first, second] = await Promise.all([
      registry.release('tab:leaf'),
      registry.release('tab:leaf')
    ])

    expect(exitProofs).toBe(1)
    expect(first).toEqual({ released: true, sessionId: 'session-a' })
    expect(second).toEqual(first)
    expect(registry.get('tab:leaf')).toBeNull()
  })
})
