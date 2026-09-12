import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers,
  type SharedControlTestServer
} from '../../shared/remote-runtime-shared-control-test-server'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/runtime-environment-store'
import { registerRuntimeEnvironmentReconciliationHandlers } from './runtime-environment-reconciliation-handlers'

const handle = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { handle } }))

let directory: string
let server: SharedControlTestServer
let accepted: Set<string>
const retire = vi.fn()
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false })
const rows = () => listEnvironments(directory)
const prepare = {
  action: 'prepare',
  requestId: 'encrypted-proof',
  environmentIds: ['canonical', 'historical'],
  canonicalEnvironmentId: 'canonical'
}
const selection = { requestId: prepare.requestId, environmentId: 'historical' }
const call = (input: unknown) => handle.mock.calls[0][1]({ sender: owner() }, input)

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  directory = mkdtempSync(join(tmpdir(), 'orca-reconcile-encrypted-'))
  accepted = new Set(['grant-canonical', 'grant-historical'])
  server = await createSharedControlTestServer({
    acceptedDeviceTokens: accepted,
    responseResult: () => ({
      runtimeId: 'runtime-test',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      deviceScope: 'runtime'
    })
  })
  for (const id of prepare.environmentIds) {
    addEnvironmentFromPairingCode(directory, {
      id,
      name: id,
      now: 1,
      pairingCode: encodePairingOffer({ ...server.pairing, deviceToken: `grant-${id}` })
    })
  }
  registerRuntimeEnvironmentReconciliationHandlers({
    getUserDataPath: () => directory,
    retireControlTransport: retire
  })
})

afterEach(async () => {
  await closeSharedControlTestServers()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('proves both grants over encrypted sockets and supports offline reversal without losing either row', async () => {
  const original = rows()
  await expect(call(prepare)).resolves.toMatchObject({ record: { stage: 'prepared' } })
  const activated = await call({ ...selection, action: 'activate' })
  expect(activated.record.stage).toBe('catalog-active')
  expect(JSON.stringify(activated)).not.toContain('grant-')
  expect(server.auths).toEqual(
    ['grant-canonical', 'grant-historical', 'grant-canonical', 'grant-historical'].map(
      (deviceToken) => expect.objectContaining({ type: 'e2ee_auth', deviceToken })
    )
  )
  expect(server.requests.map((request) => request.method)).toEqual(Array(4).fill('status.get'))
  expect(retire.mock.calls).toEqual([['canonical'], ['historical']])
  await closeSharedControlTestServers()
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
  await expect(call({ ...selection, action: 'reverse' })).resolves.toMatchObject({
    record: { stage: 'prepared' }
  })
  await expect(call({ ...selection, action: 'cancel' })).resolves.toEqual({ record: null })
  expect(rows()).toEqual(original)
})

it('refuses preparation when one saved grant is unauthorized without publishing intent', async () => {
  const original = rows()
  accepted.delete('grant-historical')
  await expect(call(prepare)).rejects.toThrow()
  expect(rows()).toEqual(original)
  expect(retire).not.toHaveBeenCalled()
  expect(server.requests).toHaveLength(1)
})

it('reauthenticates at activation and leaves prepared intent intact after grant revocation', async () => {
  await call(prepare)
  const prepared = rows()
  accepted.delete('grant-historical')
  await expect(call({ ...selection, action: 'activate' })).rejects.toThrow()
  expect(rows()).toEqual(prepared)
  expect(retire).not.toHaveBeenCalled()
  expect(server.requests).toHaveLength(3)
  accepted.add('grant-historical')
  await expect(call({ ...selection, action: 'activate' })).resolves.toMatchObject({
    record: { stage: 'catalog-active' }
  })
})
