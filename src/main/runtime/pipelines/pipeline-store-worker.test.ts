import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PipelineStoreWorkerClient } from './pipeline-store-worker-client'
import {
  closePipelineWorkerStores,
  handlePipelineStoreRequest
} from './pipeline-store-worker-entry'
import { inProcessWorker } from '../../worker-threads/in-process-worker.test-fixture'
import { pipelineV2AdmissionFixture } from './v2/pipeline-v2.test-fixture'
import type { PipelineStoreRemote } from './pipeline-store-port'
import type { PipelineStoreWorkerRequest } from './pipeline-store-worker-protocol'

const roots: string[] = []
const stores: PipelineStoreRemote[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close()
  }
  closePipelineWorkerStores()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-pipeline-worker-'))
  roots.push(root)
  const transport = inProcessWorker(handlePipelineStoreRequest)
  const client = new PipelineStoreWorkerClient(
    join(root, 'runs.sqlite'),
    () => {},
    transport.factory
  )
  stores.push(client.store)
  return { store: client.store, controls: transport.controls }
}

it('keeps a committed mutation after a lost acknowledgement and replays its exact receipt once', async () => {
  const { store, controls } = fixture()
  await store.createV2(pipelineV2AdmissionFixture())
  const mutation = {
    requestId: 'pause-once',
    expectedRevision: 0,
    expectedInstanceId: 'instance-1',
    command: { kind: 'pause' }
  }
  controls.crashesOn = (request: PipelineStoreWorkerRequest) => {
    if (request.op !== 'commandV2') {
      return false
    }
    const committed = handlePipelineStoreRequest(request)
    if (!committed.ok) {
      throw new Error(committed.error)
    }
    closePipelineWorkerStores()
    return true
  }
  await expect(store.commandV2('run-1', mutation)).rejects.toThrow('pipeline_store_outcome_unknown')
  controls.crashesOn = () => false
  expect(await store.receiptV2('run-1', 'pause-once')).toMatchObject({
    acceptedRevision: 1,
    state: 'paused'
  })
  expect(await store.commandV2('run-1', mutation)).toMatchObject({ revision: 1, state: 'paused' })
  expect((await store.eventsV2('run-1', 0)).events.map((event) => event.kind)).toEqual([
    'create',
    'pause'
  ])
})

it('serializes competing revisions and retains immutable definitions across a worker reopen', async () => {
  const { store } = fixture()
  const created = await store.createV2(pipelineV2AdmissionFixture())
  const outcomes = await Promise.allSettled(
    ['pause-a', 'pause-b'].map((requestId) =>
      store.commandV2('run-1', {
        requestId,
        expectedRevision: 0,
        expectedInstanceId: 'instance-1',
        command: { kind: 'pause' }
      })
    )
  )
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected'])
  closePipelineWorkerStores()
  const reopened = await store.getV2('run-1')
  expect(reopened.revision).toBe(1)
  expect(reopened.definition).toEqual(created.definition)
  expect(reopened.definitionDigest).toBe(created.definitionDigest)
})
