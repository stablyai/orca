import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../shared/remote-runtime-shared-control-test-server'
import { getRuntimeEnvironmentStatus } from './runtime-environment-transport-routing'
import {
  getRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'

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
  const environment = addEnvironmentFromPairingCode(profile, {
    name: 'host',
    pairingCode: encodePairingOffer(server.pairing)
  })
  await getRuntimeEnvironmentStatus(profile, environment.id)
  const owner = getRuntimeEnvironmentStatusOwner(profile, environment.id)
  await vi.waitFor(
    () => {
      expect(owner.read()).toMatchObject({ transport: 'ready', verification: 'verified' })
      expect(server.requests).toHaveLength(2)
    },
    { timeout: 3_000 }
  )
  expect(server.connectionCount()).toBe(2) // Bootstrap plus persistent control.
  runtimeId = 'host-after'
  server.closeClients()
  await vi.waitFor(
    () => {
      expect(owner.read().status?.runtimeId).toBe('host-after')
      expect(owner.read().verification).toBe('verified')
    },
    { timeout: 3_000 }
  )
  expect(server.connectionCount()).toBe(3)
  expect(server.requests.map((request) => request.method)).toEqual([
    'status.get',
    'status.get',
    'status.get'
  ])
})
