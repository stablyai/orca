import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverOrcadDelegatedClaim } from './orcad-delegated-claim-recovery'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD,
  parsePtyOwnershipTransferDestinationClaimRequest
} from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferRequestTransport } from '../providers/ssh-pty-ownership-transfer-client'

let directory: string
let store: PtyOwnershipTransferDestinationFileStore
const first = { version: 1, previousClaim: null, claim: { generation: 1, claimId: 'first' } }
const second = {
  version: 1,
  previousClaim: first.claim,
  claim: { generation: 2, claimId: 'second' }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-claim-recovery-'))
  store = new PtyOwnershipTransferDestinationFileStore({ directory })
  store.prepare(identity, 0)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: request(),
    endpoint: '/incumbent.sock',
    incumbentVersion: 'incumbent',
    endpointCredential: 'endpoint-secret'
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function setup(patch: Record<string, unknown> = {}) {
  let active = true
  const status = {
    ...identity,
    version: 1,
    phase: 'prepared',
    destinationClaim: null,
    boundToConnection: false,
    ...patch
  }
  const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async (method, params) => {
    if (method !== PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD) {
      return status
    }
    const request = parsePtyOwnershipTransferDestinationClaimRequest(params)
    expect(store.loadDelegatedClaimIntent(identity)?.claim).toEqual({
      generation: request.destinationGeneration,
      claimId: request.claimId
    })
    return {
      ...identity,
      version: 1,
      destinationGeneration: request.destinationGeneration,
      claimId: request.claimId
    }
  })
  const createClaimId = vi.fn(() => (patch.destinationClaim ? 'second' : 'first'))
  const recover = () =>
    recoverOrcadDelegatedClaim({
      identity,
      store,
      client: new OrcadDelegatedTransferClient(transport),
      isActive: () => active,
      createClaimId
    })
  return {
    recover,
    transport,
    createClaimId,
    status,
    deactivate: () => {
      active = false
    }
  }
}

it('persists initial intent before the first source claim', async () => {
  const fixture = setup()
  await expect(fixture.recover()).resolves.toEqual(first.claim)
  expect(
    new PtyOwnershipTransferDestinationFileStore({ directory }).loadDelegatedClaimIntent(identity)
  ).toEqual(first)
})

it('retries a stored reservation unchanged when the source still has its predecessor', async () => {
  store.reserveDelegatedClaimIntent(identity, null, first)
  store.reserveDelegatedClaimIntent(identity, first, second)
  const fixture = setup({ destinationClaim: first.claim })
  await expect(fixture.recover()).resolves.toEqual(second.claim)
  expect(fixture.createClaimId).not.toHaveBeenCalled()
  expect(store.loadDelegatedClaimIntent(identity)).toEqual(second)
})

it('reuses an own claim still bound to this connection without another RPC', async () => {
  store.reserveDelegatedClaimIntent(identity, null, first)
  const fixture = setup({ destinationClaim: first.claim, boundToConnection: true })
  await expect(fixture.recover()).resolves.toEqual(first.claim)
  expect(fixture.transport).toHaveBeenCalledOnce()
  expect(fixture.createClaimId).not.toHaveBeenCalled()
})

it('reserves a successor after reconnect observes its own previous successful claim', async () => {
  store.reserveDelegatedClaimIntent(identity, null, first)
  const fixture = setup({ destinationClaim: first.claim })
  await expect(fixture.recover()).resolves.toEqual(second.claim)
  expect(store.loadDelegatedClaimIntent(identity)).toEqual(second)
})

it.each([
  { destinationClaim: { generation: 1, claimId: 'foreign' } },
  { destinationClaim: { generation: 3, claimId: 'foreign' } },
  { phase: 'aborted' }
])('does not reserve or claim conflicting source state %#', async (patch) => {
  store.reserveDelegatedClaimIntent(identity, null, first)
  const fixture = setup(patch)
  await expect(fixture.recover()).rejects.toThrow('recovery_conflict')
  expect(store.loadDelegatedClaimIntent(identity)).toEqual(first)
  expect(fixture.transport).toHaveBeenCalledOnce()
})

it('never adopts a source claim without durable evidence it belongs to this destination', async () => {
  const fixture = setup({ destinationClaim: first.claim })
  await expect(fixture.recover()).rejects.toThrow('recovery_conflict')
  expect(store.loadDelegatedClaimIntent(identity)).toBeNull()
})

it.each([false, true])(
  'sends no claim after an uncertain destination reservation (written=%s)',
  async (written) => {
    const fixture = setup()
    const reserve = store.reserveDelegatedClaimIntent.bind(store)
    vi.spyOn(store, 'reserveDelegatedClaimIntent').mockImplementationOnce((...args) => {
      if (written) {
        reserve(...args)
      }
      throw new Error('uncertain write')
    })
    await expect(fixture.recover()).rejects.toThrow('uncertain write')
    expect(fixture.transport).toHaveBeenCalledOnce()
    expect(store.loadDelegatedClaimIntent(identity)).toEqual(written ? first : null)
    await expect(fixture.recover()).resolves.toEqual(first.claim)
  }
)

it('does not return ownership after cancellation during the claim response', async () => {
  const fixture = setup()
  const transport = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementation(async (...args) => {
    const response = await transport(...args)
    if (args[0] === PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD) {
      fixture.deactivate()
    }
    return response
  })
  await expect(fixture.recover()).rejects.toThrow('recovery_stale')
  expect(store.loadDelegatedClaimIntent(identity)).toEqual(first)
})

it('does not claim after another coordinator reserves during status discovery', async () => {
  const fixture = setup()
  fixture.transport.mockImplementationOnce(async () => {
    store.reserveDelegatedClaimIntent(identity, null, first)
    return fixture.status
  })
  await expect(fixture.recover()).rejects.toThrow('recovery_stale')
  expect(fixture.transport).toHaveBeenCalledOnce()
})

it('retains intent when the source reply is lost and reconciles it on reconnect', async () => {
  const fixture = setup()
  const transport = fixture.transport.getMockImplementation()!
  fixture.transport.mockImplementation(async (...args) => {
    await transport(...args)
    if (args[0] === PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD) {
      throw new Error('response lost')
    }
    return fixture.status
  })
  await expect(fixture.recover()).rejects.toThrow('response lost')
  const reconnect = setup({ destinationClaim: first.claim })
  await expect(reconnect.recover()).resolves.toEqual(second.claim)
})
