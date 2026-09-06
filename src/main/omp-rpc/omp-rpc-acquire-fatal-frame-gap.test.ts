// XLR-R6-001 (cross-lab review): the window between a command RESPONSE and the
// session wrapper that retains fatal frames. OMP can emit a valid response and
// then garbage out of one stdout chunk, so the fault fires before acquisition's
// last await resolves — i.e. before OmpRpcChatSession exists to retain it.
// Split from omp-rpc-chat-session-registry.ts's own test file so neither
// exceeds its max-lines budget.

import { afterEach, describe, expect, it } from 'vitest'
import type { OmpRpcClientEvent, OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcClientEventFanout } from './omp-rpc-client-event-fanout'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function makeRegistry(): OmpRpcChatSessionRegistry {
  return new OmpRpcChatSessionRegistry({
    spawnClient: () => {
      const client = spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            malformedAfterGetState: '{ this is not json',
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

describe('OmpRpcClientEventFanout fatal retention', () => {
  it('replays the first fatal frame to a listener that attached after it', () => {
    const fanout = new OmpRpcClientEventFanout()
    fanout.emit({ kind: 'protocol-fault', message: 'malformed JSON' })
    fanout.emit({ kind: 'exit', code: 1, signal: null })
    const seen: OmpRpcClientEvent[] = []
    fanout.on((event) => seen.push(event))
    expect(seen).toEqual([{ kind: 'protocol-fault', message: 'malformed JSON' }])
  })

  it('keeps the retained fatal frame across the exit path listener teardown', () => {
    const fanout = new OmpRpcClientEventFanout()
    fanout.emit({ kind: 'exit', code: 17, signal: null })
    fanout.clear()
    const seen: OmpRpcClientEvent[] = []
    fanout.on((event) => seen.push(event))
    expect(seen).toEqual([{ kind: 'exit', code: 17, signal: null }])
  })

  it('does not replay ordinary stream events', () => {
    const fanout = new OmpRpcClientEventFanout()
    fanout.emit({ kind: 'command-output', text: 'hello' })
    const seen: OmpRpcClientEvent[] = []
    fanout.on((event) => seen.push(event))
    expect(seen).toEqual([])
  })
})

describe('OmpRpcChatSessionRegistry response-to-subscription gap', () => {
  // Without retention the pane stays 'acquired' over an unusable client: the
  // renderer's subscribe attaches after the fault and sees nothing, so it never
  // faults the pane and never asks for the PTY acquisition killed.
  it('delivers a fault raised during acquisition to the pane that subscribes later', async () => {
    const registry = makeRegistry()
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('acquired')

    const session = registry.get('tab:leaf')
    expect(session).not.toBeNull()
    const seen: OmpRpcClientEvent[] = []
    session?.on((event) => seen.push(event))
    expect(seen).toEqual([
      { kind: 'protocol-fault', message: 'OMP RPC emitted malformed JSON: { this is not json' }
    ])
  })
})
