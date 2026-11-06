import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addManagedOrcadEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  registerManagedServerActions,
  type ManagedServerActions
} from '../../runtime/managed-server-actions-registry'
import { removeRedundantManagedPairing } from './runtime-environment-redundant-managed-removal'

const forgetRedundant = vi.fn<ManagedServerActions['forgetRedundant']>()
let userDataPath: string

const pairingCode = (port: number, publicKeyB64: string) =>
  encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: `ws://127.0.0.1:${port}/`,
    deviceToken: `device-${port}`,
    publicKeyB64
  })

function addManaged(id: string, sshTargetId: string, port: number, publicKeyB64: string) {
  return addManagedOrcadEnvironment(userDataPath, {
    id,
    name: id,
    pairingCode: pairingCode(port, publicKeyB64),
    orcadDeployment: { sshTargetId, sshTargetGeneration: 1, localPort: port, remotePort: 6_768 }
  })
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'redundant-managed-removal-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal only calls forgetRedundant.
  registerManagedServerActions({ forgetRedundant } as unknown as ManagedServerActions)
})

afterEach(() => {
  registerManagedServerActions(null)
  forgetRedundant.mockReset()
  rmSync(userDataPath, { recursive: true, force: true })
})

it('removes a managed entry through forgetRedundant while another entry manages the server', async () => {
  const environment = addManaged('managed', 'ssh-1', 46_768, 'public-key')
  addManaged('managed-alias', 'ssh-2', 46_769, 'public-key')
  forgetRedundant.mockResolvedValueOnce({
    outcome: 'forgotten',
    verdict: 'unverifiable',
    environmentId: 'managed',
    sshTargetId: 'ssh-1'
  })
  await expect(removeRedundantManagedPairing(userDataPath, environment)).resolves.toMatchObject({
    removed: { id: 'managed' }
  })
  expect(forgetRedundant).toHaveBeenCalledWith('managed')
})

it('surfaces a refusal instead of reporting the entry removed', async () => {
  const environment = addManaged('managed', 'ssh-1', 46_768, 'public-key')
  addManaged('managed-alias', 'ssh-2', 46_769, 'public-key')
  forgetRedundant.mockResolvedValueOnce({
    outcome: 'refused',
    verdict: 'live',
    code: 'orcad_forget_no_managed_twin',
    reason: 'No other saved entry manages this server anymore.'
  })
  await expect(removeRedundantManagedPairing(userDataPath, environment)).rejects.toThrow(
    'No other saved entry manages this server anymore.'
  )
})

it('leaves the pairing to the store guard when the other entry manages a different server', () => {
  const environment = addManaged('managed', 'ssh-1', 46_768, 'public-key')
  addManaged('other', 'ssh-2', 46_769, 'other-key')
  expect(removeRedundantManagedPairing(userDataPath, environment)).toBeNull()
  expect(forgetRedundant).not.toHaveBeenCalled()
})
