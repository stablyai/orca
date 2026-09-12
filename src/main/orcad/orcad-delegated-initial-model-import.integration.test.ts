import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importOrcadDelegatedInitialModel } from './orcad-delegated-initial-model-import'
import { reconcileOrcadInitialModelBaseline } from './orcad-delegated-initial-model-ack'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { createOrcadModelImportSocketFixture } from './orcad-model-import-socket-fixture'
import { createStore, testState } from '../persistence-test-harness'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import {
  identity,
  request,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let directory: string
let close: (() => Promise<void>) | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-import-socket-'))
  testState.dir = directory
})
afterEach(async () => {
  await close?.()
  close = undefined
  rmSync(directory, { recursive: true, force: true })
})

async function setup(endpointCredential = 'registered-credential') {
  const fixture = await createOrcadModelImportSocketFixture(directory, { endpointCredential })
  close = fixture.close
  return fixture
}

it('imports then acknowledges the exact model over a real authenticated socket', async () => {
  const fixture = await setup()
  const receipt = await importOrcadDelegatedInitialModel(fixture.options)
  expect(receipt).toMatchObject({
    identity,
    throughSeq: 1,
    modelSha256: fixture.selection.modelSha256
  })
  expect(fixture.accepted).toHaveBeenCalledOnce()
  expect(fixture.outbox.loadInitialModelSnapshot(identity)).toEqual(fixture.model)
  expect(fixture.source.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 0
  })
  expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([
    { seq: 1, data: 'one🙂' },
    { seq: 2, data: 'after restart' }
  ])
  const binding = fixture.store.loadDelegatedSource(identity)!
  const connection = await connectOrcadLocalRelay({ ...binding, initialize: () => {} })
  try {
    const client = new OrcadDelegatedTransferClient((method, params, options) =>
      connection.request(method, { ...params }, options)
    )
    await client.claim(request())
    const status = await reconcileOrcadInitialModelBaseline({
      proof: binding.proof,
      claim: { generation: 1, claimId: 'claim-1' },
      outbox: fixture.outbox,
      client,
      isActive: () => true
    })
    expect(status.destinationAcknowledgedSeq).toBe(1)
    expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([
      { seq: 2, data: 'after restart' }
    ])
    expect(fixture.outbox.loadInitialModelSnapshot(identity)).toEqual(fixture.model)
  } finally {
    connection.dispose()
  }
})

it('refuses an endpoint credential mismatch before importing any snapshot', async () => {
  const fixture = await setup('different-credential')
  await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow()
  expect(fixture.accepted).not.toHaveBeenCalled()
  expect(fixture.outbox.loadInitialModelSnapshot(identity)).toBeNull()
})

it('prepares and publishes the captured boundary over authenticated sockets before claim and baseline ACK', async () => {
  const fixture = await setup()
  const registry = new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store: createStore(),
    publishPostCommitOutput: vi.fn(),
    publishPostCommitOutputAcknowledged: (identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    })
  })
  const binding = fixture.store.loadDelegatedSource(identity)!
  const prepared = await registry.prepareCapturedDelegated({
    identity,
    source: binding,
    model: fixture.model,
    signal: fixture.controller.signal
  })
  expect(prepared.snapshot).toMatchObject({
    phase: 'published',
    acceptedSourceEndSeq: 1,
    stagedOutputFrames: 0
  })
  expect(prepared.outputOutbox.loadInitialModelSnapshot(identity)).toEqual(fixture.model)
  expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
  const connection = await connectOrcadLocalRelay({ ...binding, initialize: () => {} })
  try {
    const client = new OrcadDelegatedTransferClient((method, params, options) =>
      connection.request(method, { ...params }, options)
    )
    await client.claim(request())
    const status = await reconcileOrcadInitialModelBaseline({
      proof: binding.proof,
      claim: { generation: 1, claimId: 'claim-1' },
      outbox: prepared.outputOutbox,
      client,
      isActive: () => true
    })
    expect(status).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      destinationAcknowledgedSeq: 1
    })
    expect(fixture.sourceStore.loadAll()[0].history.frames).toEqual([
      { seq: 2, data: 'after restart' }
    ])
  } finally {
    connection.dispose()
  }
})
