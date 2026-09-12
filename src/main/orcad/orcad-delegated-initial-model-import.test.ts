import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importOrcadDelegatedInitialModel } from './orcad-delegated-initial-model-import'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  identity,
  request,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { createOrcadModelImportFixture } from './orcad-model-import-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD as STATUS } from '../../shared/pty-ownership-transfer-destination-claim'
import * as durable from '../durable-file-write'

vi.mock('./orcad-local-relay-connection', () => ({ connectOrcadLocalRelay: vi.fn() }))
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-model-import-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(connectOrcadLocalRelay).mockReset()
  rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const fixture = createOrcadModelImportFixture(directory)
  const rpc = vi.fn<SshChannelMultiplexer['request']>(async (method, params) => {
    expect(method).toBe(STATUS)
    return fixture.source.inspectDestination(params, context())
  })
  const dispose = vi.fn()
  vi.mocked(connectOrcadLocalRelay).mockImplementation(async (options) => {
    const connection = {
      request: rpc,
      dispose,
      onDispose: vi.fn(() => () => {})
    } as unknown as SshChannelMultiplexer
    options.initialize(connection)
    return connection
  })
  return { ...fixture, rpc, dispose }
}

it('imports only after authenticating the selected digest, then returns a durable reread receipt', async () => {
  const fixture = setup()
  fixture.source.observeOutput(identity.terminalId, 'later')
  const receipt = await importOrcadDelegatedInitialModel(fixture.options)
  expect(receipt).toEqual({
    version: 1,
    identity,
    throughSeq: 1,
    modelSha256: fixture.selection.modelSha256
  })
  expect(connectOrcadLocalRelay).toHaveBeenCalledWith(
    expect.objectContaining({
      endpoint: '/registered.sock',
      incumbentVersion: 'registered-build',
      endpointCredential: 'registered-credential'
    })
  )
  expect(fixture.rpc).toHaveBeenCalledTimes(2)
  expect(fixture.dispose).toHaveBeenCalledOnce()
  const reopened = new PtyOwnershipTransferDestinationOutputOutbox({
    directory: join(directory, 'outbox')
  })
  expect(reopened.loadInitialModelSnapshot(identity)).toEqual(fixture.model)
  expect(fixture.source.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 0
  })
  expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  expect(await importOrcadDelegatedInitialModel({ ...fixture.options, outbox: reopened })).toEqual(
    receipt
  )
  expect(write).not.toHaveBeenCalled()
})

it.each(['digest', 'missing', 'identity', 'aborted'])(
  'refuses %s source evidence before writing a model',
  async (mode) => {
    const fixture = setup()
    if (mode === 'digest') {
      fixture.options.model = { ...fixture.model, modelData: 'different' }
    } else {
      fixture.rpc.mockImplementation(async () => ({
        ...fixture.source.inspectDestination(request(), context()),
        ...(mode === 'missing' ? { captureBaseline: undefined } : {}),
        ...(mode === 'identity' ? { destinationRuntimeId: 'other' } : {}),
        ...(mode === 'aborted' ? { phase: 'aborted' } : {})
      }))
    }
    await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow()
    expect(fixture.outbox.loadInitialModelSnapshot(identity)).toBeNull()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  }
)

it('refuses import if the source credential is not authorized', async () => {
  const fixture = setup()
  fixture.rpc.mockImplementation(async (_method, params) =>
    fixture.source.inspectDestination({ ...params, credential: '0'.repeat(64) }, context())
  )
  await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow('unauthorized')
  expect(fixture.outbox.loadInitialModelSnapshot(identity)).toBeNull()
})

it('withholds the receipt when source evidence disappears after the durable write', async () => {
  const fixture = setup()
  fixture.rpc
    .mockImplementationOnce(async () => fixture.source.inspectDestination(request(), context()))
    .mockImplementationOnce(async () => ({
      ...fixture.source.inspectDestination(request(), context()),
      captureBaseline: undefined
    }))
  await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow('source_mismatch')
  expect(fixture.outbox.loadInitialModelSnapshot(identity)).toEqual(fixture.model)
  expect(fixture.source.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 0
  })
})

it.each(['before', 'after'])(
  'returns no receipt on an uncertain %s write, with safe retry',
  async (mode) => {
    const fixture = setup()
    const write = durable.writeFileDurableSync
    const fault = vi.spyOn(durable, 'writeFileDurableSync').mockImplementation((...args) => {
      if (mode === 'after') {
        write(...args)
      }
      throw new Error('uncertain write')
    })
    await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow(
      'uncertain write'
    )
    expect(fixture.source.inspectDestination(request(), context())).toMatchObject({
      destinationAcknowledgedSeq: 0
    })
    fault.mockRestore()
    await expect(importOrcadDelegatedInitialModel(fixture.options)).resolves.toMatchObject({
      modelSha256: fixture.selection.modelSha256
    })
  }
)

it('honors cancellation after source inspection without persisting the model', async () => {
  const fixture = setup()
  fixture.rpc.mockImplementation(async () => {
    fixture.controller.abort()
    return fixture.source.inspectDestination(request(), context())
  })
  await expect(importOrcadDelegatedInitialModel(fixture.options)).rejects.toThrow()
  expect(fixture.outbox.loadInitialModelSnapshot(identity)).toBeNull()
})
