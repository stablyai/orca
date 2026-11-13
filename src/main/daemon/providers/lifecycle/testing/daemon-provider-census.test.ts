import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../../../ipc/pty/provider/registry', () => ({ setLocalPtyProvider: vi.fn() }))

import { DaemonPtyRouter } from '../../routing/daemon-pty-router'
import { createAdapter } from '../../routing/testing/daemon-pty-router-test-fixture'
import {
  disconnectDaemon,
  listLiveDaemonSessions,
  replaceDaemonProvider,
  requestIdleDaemonRetirement
} from '../daemon-provider-state'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

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
