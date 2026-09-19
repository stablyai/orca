import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureOutgoingOrcadModel } from './orcad-outgoing-capture'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../../shared/pty-ownership-capture-wire'
import * as secure from '../../shared/secure-file'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-capture-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const modelFixture = createOrcadModelImportFixture(root)
  const store = new OrcadOutgoingCaptureStore(root)
  const request = vi.fn(async (method: string) => {
    if (method === methods.begin) {
      return { version: 1, captureToken: 'capture' }
    }
    if (method === methods.inspect) {
      return { version: 1, boundary: modelFixture.selection.boundary }
    }
    if (method === methods.select) {
      const persisted = new OrcadOutgoingCaptureStore(root).read(identity)
      expect(persisted?.model).toEqual(modelFixture.model)
      expect(persisted?.selection).toEqual(modelFixture.selection)
      return { version: 1, baseline: modelFixture.selection }
    }
    return { version: 1, released: true }
  })
  const options = {
    store,
    destination: {
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      source: modelFixture.store.loadDelegatedSource(identity)!,
      surfaceBinding: preparation.surfacePublication.surfaceBinding
    },
    capture: {
      identity,
      route: { ptyId: 'ssh:source@@pty-1', providerGeneration: 1 },
      capabilities: { captureBoundaryVersion: 1 as const, captureSelectionVersion: 1 as const },
      request,
      signal: new AbortController().signal,
      runtime: {
        serializeSshPtyOwnershipCapture: vi.fn(async () =>
          parsePtyOwnershipInitialModelSnapshot(
            modelFixture.model,
            identity,
            modelFixture.model.throughSeq
          )
        )
      }
    }
  }
  return { options, request, store }
}

it('persists catalog-required version before source baseline selection', async () => {
  const f = fixture()
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const catalogAdmission = {
    version: 1 as const,
    manifest,
    bindings: [{ identity, surfaceBinding: f.options.destination.surfaceBinding }]
  }
  const select = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method) => {
    if (method === methods.select) {
      expect(new OrcadOutgoingCaptureStore(root).read(identity)).toMatchObject({
        version: 2,
        catalogAdmission
      })
    }
    return select(method)
  })
  const saved = await captureOutgoingOrcadModel({
    ...f.options,
    destination: {
      ...f.options.destination,
      sourceSshTargetId: manifest.source.sshTargetId,
      sourceSshTargetGeneration: manifest.source.sshTargetGeneration!,
      catalogAdmission
    }
  })
  expect(saved.catalogAdmission).toEqual(catalogAdmission)
})

it('persists exact capture bytes before selecting and refuses fresh capture after reconstruction', async () => {
  const f = fixture()
  const saved = await captureOutgoingOrcadModel(f.options)
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.select,
    methods.release
  ])
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).toEqual(saved)
  f.request.mockClear()
  await expect(
    captureOutgoingOrcadModel({ ...f.options, store: new OrcadOutgoingCaptureStore(root) })
  ).rejects.toThrow('recovery_required')
  expect(f.request).not.toHaveBeenCalled()
})

it('releases without selecting when the secure durable writer fails', async () => {
  const f = fixture()
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  await expect(captureOutgoingOrcadModel(f.options)).rejects.toThrow('disk full')
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.release
  ])
  expect(f.store.read(identity)).toBeNull()
})

it.each([methods.select, methods.release])(
  'retains recovery bytes when %s response is lost',
  async (failure) => {
    const f = fixture()
    const normal = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method) => {
      const response = await normal(method)
      if (method === failure) {
        throw new Error('response lost')
      }
      return response
    })
    await expect(captureOutgoingOrcadModel(f.options)).rejects.toThrow('response lost')
    expect(new OrcadOutgoingCaptureStore(root).read(identity)).not.toBeNull()
    expect(f.request.mock.lastCall?.[0]).toBe(methods.release)
  }
)
