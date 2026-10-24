import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  updateEnvironmentFromPairingCode
} from '../../shared/runtime-environment-store'
import { enqueueRuntimeCall } from '../ipc/runtime-environments/runtime-environment-call-queue'
import { bindRuntimeSessionSearch } from './runtime-session-search-call'

const send = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../ipc/runtime-environments/runtime-environment-abortable-requests', () => ({
  sendRemoteRuntimeConnectionRequestAbortable: send,
  sendRemoteRuntimeRequestAbortable: send
}))

it.each(['pairing', 'runtime'] as const)(
  'refuses a queued search after the selected %s changes before dispatch',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'sta10541-search-queue-'))
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockers: Promise<void>[] = []
    try {
      send.mockClear()
      const pairingCode = encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:9',
        deviceToken: 'a'.repeat(48),
        publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
      })
      const env = addEnvironmentFromPairingCode(root, { name: 'search-host', pairingCode })
      markEnvironmentUsed(root, env.id, { runtimeId: 'runtime-a' })
      const call = bindRuntimeSessionSearch(root, env.id)
      for (let index = 0; index < 8; index++) {
        blockers.push(enqueueRuntimeCall(env.id, 'aiVault.searchSessions', () => held))
      }
      const result = call('aiVault.searchSessions', {
        query: 'needle',
        within: { kind: 'project', projectKey: 'project:P', canonicalProjectKey: 'repo:b' }
      }).then(
        () => {
          throw new Error('changed target accepted')
        },
        (error: unknown) => error
      )
      if (change === 'pairing') {
        updateEnvironmentFromPairingCode(root, env.id, { pairingCode })
      } else {
        markEnvironmentUsed(root, env.id, { runtimeId: 'runtime-b' })
      }
      release()
      await Promise.all(blockers)
      expect(await result).toMatchObject({ code: 'runtime_environment_changed' })
      expect(send).not.toHaveBeenCalled()
    } finally {
      release()
      await Promise.all(blockers)
      await rm(root, { recursive: true, force: true })
    }
  }
)
