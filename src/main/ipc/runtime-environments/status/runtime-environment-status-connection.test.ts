import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import '../../../../shared/protocol-version'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/host-runtime-capabilities'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import {
  getRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners
} from '../connections/runtime-environment-request-connections'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const profiles: string[] = []
afterEach(async () => {
  resetRuntimeEnvironmentStatusOwners()
  await closeSharedControlTestServers()
  profiles.splice(0).forEach((profile) => rmSync(profile, { recursive: true, force: true }))
})

it('publishes real same-socket verification after every authenticated reconnect', async () => {
  let runtimeId = 'host-before'
  const server = await createSharedControlTestServer({
    resultForRequest: () => ({
      runtimeId,
      capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
    })
  })
  const profile = mkdtempSync(join(tmpdir(), 'orca-status-socket-'))
  profiles.push(profile)
  const environment = await addEnvironmentFromPairingCode(profile, {
    name: 'host',
    pairingCode: encodePairingOffer(server.offer)
  })
  await getRuntimeEnvironmentStatus(profile, environment.id)
  const owner = await getRuntimeEnvironmentStatusOwner(profile, environment.id)
  await vi.waitFor(
    () => {
      expect(owner.read()).toMatchObject({ transport: 'ready', verification: 'verified' })
    },
    { timeout: 3_000 }
  )
  runtimeId = 'host-after'
  server.closeClients()
  await vi.waitFor(
    () => {
      expect(owner.read().status?.runtimeId).toBe('host-after')
      expect(owner.read().verification).toBe('verified')
    },
    { timeout: 3_000 }
  )
})
