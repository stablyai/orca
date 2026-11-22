import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../../../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: vi.fn(),
  setLocalPtyProvider: vi.fn()
}))

import { DaemonPtyRouter } from '../../routing/daemon-pty-router'
import { createAdapter } from '../../routing/testing/daemon-pty-router-test-fixture'
import {
  countInProcessTerminals,
  disconnectDaemon,
  listLiveDaemonSessions,
  replaceDaemonProvider
} from '../daemon-provider-state'
import { getLocalPtyProvider } from '../../../../ipc/pty/provider/registry'
import { LocalPtyProvider } from '../../../../providers/local-pty/local-pty-provider'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

afterEach(async () => {
  await disconnectDaemon()
})

it('reads a census with an unanswered generation as unverifiable', async () => {
  const current = createAdapter('current', ['live-1'], undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
  vi.mocked(legacy.listSessions).mockRejectedValue(new Error('daemon unreachable'))
  replaceDaemonProvider(new DaemonPtyRouter({ current, legacy: [legacy] }))

  await expect(listLiveDaemonSessions()).resolves.toBeNull()
})

it('counts every local terminal as in-process when no daemon started', async () => {
  const local: LocalPtyProvider = Object.create(LocalPtyProvider.prototype)
  local.listProcesses = async () => [
    { id: 'pty-1', cwd: '/', title: 'sh' },
    { id: 'pty-2', cwd: '/', title: 'sh' }
  ]
  vi.mocked(getLocalPtyProvider).mockReturnValue(local)

  await expect(countInProcessTerminals()).resolves.toBe(2)
})
