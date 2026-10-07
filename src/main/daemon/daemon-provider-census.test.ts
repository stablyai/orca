import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../ipc/pty', () => ({ setLocalPtyProvider: vi.fn() }))

import { DaemonPtyRouter } from './daemon-pty-router'
import { createAdapter } from './daemon-pty-router-test-fixture'
import {
  disconnectDaemon,
  listLiveDaemonSessions,
  listLiveDaemonSessionsWithProtocol,
  replaceDaemonProvider,
  requestIdleDaemonRetirement
} from './daemon-provider-state'
import { PROTOCOL_VERSION } from './types'

afterEach(async () => {
  await disconnectDaemon()
})

it('reads a census without an installed daemon as unverifiable, never as empty', async () => {
  await expect(listLiveDaemonSessions()).resolves.toBeNull()
  await expect(requestIdleDaemonRetirement()).resolves.toEqual({ state: 'unverifiable' })
})

it('reads a census with an unanswered generation as unverifiable', async () => {
  const current = createAdapter('current', ['live-1'], undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
  vi.mocked(legacy.listSessions).mockRejectedValue(new Error('daemon unreachable'))
  replaceDaemonProvider(new DaemonPtyRouter({ current, legacy: [legacy] }))

  await expect(listLiveDaemonSessions()).resolves.toBeNull()
})

it('labels each live session with the protocol of the generation that owns it', async () => {
  const current = createAdapter('current', ['live-1'], undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', ['live-2'], undefined, PROTOCOL_VERSION - 1)
  replaceDaemonProvider(new DaemonPtyRouter({ current, legacy: [legacy] }))

  await expect(listLiveDaemonSessionsWithProtocol()).resolves.toEqual([
    { sessionId: 'live-1', isAlive: true, protocolVersion: PROTOCOL_VERSION },
    { sessionId: 'live-2', isAlive: true, protocolVersion: PROTOCOL_VERSION - 1 }
  ])
})

it('lists every generation when each one answers', async () => {
  const current = createAdapter('current', ['live-1'], undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', ['live-2'], undefined, PROTOCOL_VERSION)
  replaceDaemonProvider(new DaemonPtyRouter({ current, legacy: [legacy] }))

  await expect(listLiveDaemonSessions()).resolves.toEqual([
    { sessionId: 'live-1', isAlive: true },
    { sessionId: 'live-2', isAlive: true }
  ])
})
