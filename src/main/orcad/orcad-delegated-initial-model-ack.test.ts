import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { reconcileOrcadInitialModelBaseline } from './orcad-delegated-initial-model-ack'
import { createOrcadModelImportFixture } from './orcad-model-import-test-fixture'
import {
  identity,
  request,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipTransferDestinationStatus } from '../../shared/pty-ownership-transfer-destination-status'
import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-model-ack-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function setup(seed = true) {
  const fixture = createOrcadModelImportFixture(directory)
  if (seed) {
    fixture.outbox.recordInitialModelSnapshot(identity, fixture.model)
  }
  fixture.source.claimDestination(request(), context())
  let acknowledged = 0
  const response = () =>
    parsePtyOwnershipTransferDestinationStatus({
      ...fixture.source.inspectDestination(request(), context()),
      captureImportAckVersion: 1,
      destinationAcknowledgedSeq: acknowledged
    })
  const status = vi.fn<OrcadDelegatedTransferClient['status']>(async () => response())
  const acknowledgeInitialModel = vi.fn<OrcadDelegatedTransferClient['acknowledgeInitialModel']>(
    async () => {
      acknowledged = 1
      return {
        ...identity,
        version: 1,
        receipt: { version: 1, identity, throughSeq: 1, modelSha256: fixture.selection.modelSha256 }
      }
    }
  )
  const active = vi.fn(() => true)
  const options = {
    proof: request(),
    claim: { generation: 1, claimId: 'claim-1' },
    outbox: fixture.outbox,
    client: { status, acknowledgeInitialModel },
    isActive: active
  }
  return { ...fixture, options, status, acknowledgeInitialModel, active, response }
}

it('reconstructs its receipt from disk and verifies the ACK through a fresh status read', async () => {
  const fixture = setup()
  expect(await reconcileOrcadInitialModelBaseline(fixture.options)).toMatchObject({
    destinationAcknowledgedSeq: 1
  })
  expect(fixture.status).toHaveBeenCalledTimes(2)
  expect(fixture.acknowledgeInitialModel).toHaveBeenCalledWith(
    {
      ...request(),
      destinationClaim: fixture.options.claim,
      receipt: { version: 1, identity, throughSeq: 1, modelSha256: fixture.selection.modelSha256 }
    },
    undefined
  )
})

it('keeps noncaptured old-source connection behavior unchanged', async () => {
  const fixture = setup(false)
  fixture.status.mockResolvedValue({
    ...fixture.response(),
    captureBaseline: undefined,
    captureImportAckVersion: undefined
  })
  await reconcileOrcadInitialModelBaseline(fixture.options)
  expect(fixture.acknowledgeInitialModel).not.toHaveBeenCalled()
})

it('does not resend an import ACK already recovered from source journal state', async () => {
  const fixture = setup()
  fixture.status.mockResolvedValue({ ...fixture.response(), destinationAcknowledgedSeq: 1 })
  await reconcileOrcadInitialModelBaseline(fixture.options)
  expect(fixture.acknowledgeInitialModel).not.toHaveBeenCalled()
})

it.each(['capability', 'cursor', 'baseline', 'claim', 'binding', 'model'])(
  'refuses missing or changed %s evidence',
  async (mode) => {
    const fixture = setup(mode !== 'model')
    fixture.status.mockResolvedValue({
      ...fixture.response(),
      ...(mode === 'capability' ? { captureImportAckVersion: undefined } : {}),
      ...(mode === 'cursor' ? { destinationAcknowledgedSeq: undefined } : {}),
      ...(mode === 'baseline' ? { captureBaseline: undefined } : {}),
      ...(mode === 'claim' ? { destinationClaim: { generation: 2, claimId: 'other' } } : {}),
      ...(mode === 'binding' ? { boundToConnection: false } : {})
    })
    await expect(reconcileOrcadInitialModelBaseline(fixture.options)).rejects.toThrow()
    expect(fixture.acknowledgeInitialModel).not.toHaveBeenCalled()
  }
)

it('does not trust a successful ACK reply without source cursor advancement', async () => {
  const fixture = setup()
  fixture.status.mockResolvedValue(fixture.response())
  await expect(reconcileOrcadInitialModelBaseline(fixture.options)).rejects.toThrow('unverified')
})

it('rechecks connection lifetime after the ACK await', async () => {
  const fixture = setup()
  fixture.acknowledgeInitialModel.mockImplementation(async () => {
    fixture.active.mockReturnValue(false)
    return {
      ...identity,
      version: 1,
      receipt: { version: 1, identity, throughSeq: 1, modelSha256: fixture.selection.modelSha256 }
    }
  })
  await expect(reconcileOrcadInitialModelBaseline(fixture.options)).rejects.toThrow('stale')
})
