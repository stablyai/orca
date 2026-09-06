// What a pane is owed when ACQUISITION itself fails after the RPC child was
// already spawned — the case where main can prove neither that the child took
// the session nor that it left it. Split from omp-rpc-chat-session-registry.ts's
// own test file so neither exceeds its max-lines budget.

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

describe('OmpRpcChatSessionRegistry failed acquisition', () => {
  // XLR-045 (cross-lab review): an initialization that failed with an
  // unprovable child exit travels as `rpc-child-unverifiable`, which owes the
  // pane NEITHER a respawn nor the pre-kill undo — its PTY was killed to admit
  // the spawn, and the renderer never acquired, so nothing else ever asks for
  // it back. The late exit used to release only the low-level RPC claim: no
  // hand-back obligation, no signal, so the pane stayed with neither an RPC
  // session nor a terminal until something unrelated recreated it.
  it("owes the pane its PTY back once a failed acquisition's child is finally seen to exit (XLR-045)", async () => {
    const registry = makeRegistry(
      { exitOnCommand: 'switch_session' },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    let lateExits = 0
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false,
      onLateRpcChildExit: () => {
        lateExits += 1
      }
    })
    expect(result.status).toBe('rpc-child-unverifiable')

    // The child the failed switch killed finally dies.
    await [...clients].at(-1)?.whenExited()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lateExits).toBe(1)
    // `released: true` is what makes the IPC layer push the hand-back at all,
    // so a pane that asks again after the exit is no longer refused (XLR-030).
    expect(await registry.release('tab:leaf')).toEqual({ released: true })
  })
})
