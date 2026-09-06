// The acquisition-identity half of omp-rpc-chat-session-registry.test.ts,
// split out so neither file exceeds its max-lines budget. One question only:
// which established registration a fresh acquire is allowed to reuse.

import { afterEach, describe, expect, it } from 'vitest'
import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function spawnFakeSessionOwningClient(): OmpSessionOwningRpcClient {
  const client = spawnOmpRpcClient(
    createFakeOmpRpcChild(
      {
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

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry acquisition identity', () => {
  // XLR-R3-001 (cross-lab review, round 3): `cwd` is part of the acquisition
  // identity and is immutable in the spawned child. Matching on the session
  // file alone let a pane that rebound to another working directory be handed
  // the old child as `acquired`, so prompts and tools ran in the OLD directory
  // while the renderer reported ownership of the new one.
  it('refuses to reuse an established session for a different cwd (XLR-R3-001)', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: spawnFakeSessionOwningClient,
      // The child is busy, so the reclaim release below fails closed — exactly
      // the case that used to hand the stale child back as `acquired`.
      proveRpcExit: async () => ({
        status: 'unverifiable',
        reason: 'child exit could not be proven'
      })
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work/a',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const rebound = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-2',
      cwd: '/work/b',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    expect(rebound).toEqual({ status: 'conflict' })
  })

  it('still reuses an established session for the same cwd and session file', async () => {
    const registry = new OmpRpcChatSessionRegistry({ spawnClient: spawnFakeSessionOwningClient })
    const args = {
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work/a',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    }
    const first = await registry.acquire(args)
    expect(first.status).toBe('acquired')

    const second = await registry.acquire({ ...args, ptyId: 'pty-2' })

    expect(second).toEqual(first)
  })

  // The reclaim path (XLR-014) must still work for a cwd rebind: once the old
  // child can actually be released, the pane takes its new identity.
  it('reclaims a stale registration when the cwd rebind can be released', async () => {
    let exitProvable = false
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: spawnFakeSessionOwningClient,
      proveRpcExit: async () =>
        exitProvable
          ? { status: 'exited' }
          : { status: 'unverifiable', reason: 'child exit could not be proven' }
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work/a',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    exitProvable = true
    const rebound = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-2',
      cwd: '/work/b',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    expect(rebound.status).toBe('acquired')
  })
})
