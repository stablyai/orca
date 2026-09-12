import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { publishOutgoingOrcadCapture } from './orcad-outgoing-capture-publication'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as secure from '../../shared/secure-file'

const publish = vi.hoisted(() => vi.fn())
vi.mock('./orcad-captured-destination-client', () => ({
  prepareRemoteOrcadCapturedDestination: publish
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-publish-'))
  publish.mockReset().mockResolvedValue({ outcome: 'published' })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  const store = new OrcadOutgoingCaptureStore(root)
  const saved = store.persist({
    version: 1,
    identity,
    destinationEnvironmentId: 'destination',
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    source: source.store.loadDelegatedSource(identity),
    model: source.model,
    selection: source.selection,
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  })
  const controller = new AbortController()
  const options = {
    store,
    identity,
    destinationEnvironmentId: 'destination',
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    pairingCode: 'pairing',
    signal: controller.signal,
    assertAuthority: vi.fn()
  }
  return { options, saved, controller }
}
it('publishes the exact saved capture and retains it for retries', async () => {
  const f = fixture()
  await expect(publishOutgoingOrcadCapture(f.options)).resolves.toEqual({ outcome: 'published' })
  expect(publish).toHaveBeenCalledWith({
    pairingCode: 'pairing',
    runtimeId: identity.destinationRuntimeId,
    surfaceBinding: f.saved.surfaceBinding,
    capture: {
      identity,
      source: f.saved.source,
      model: f.saved.model,
      selection: f.saved.selection,
      signal: f.controller.signal
    }
  })
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).toEqual(f.saved)
  expect(f.options.assertAuthority).toHaveBeenCalledTimes(3)
})
it.each(['destinationEnvironmentId', 'sourceSshTargetId', 'sourceSshTargetGeneration'] as const)(
  'refuses changed %s before publication',
  async (key) => {
    const f = fixture()
    Object.assign(f.options, { [key]: key === 'sourceSshTargetGeneration' ? 2 : 'other' })
    await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('authority_mismatch')
    expect(publish).not.toHaveBeenCalled()
  }
)
it('requires confirmed durable retry bytes before contact', async () => {
  const f = fixture()
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockReturnValueOnce(false)
  await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('permissions_unconfirmed')
  expect(publish).not.toHaveBeenCalled()
})
it('retains capture after a lost reply and retries from a reconstructed store', async () => {
  const f = fixture()
  publish.mockRejectedValueOnce(new Error('reply lost'))
  await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('reply lost')
  await publishOutgoingOrcadCapture({ ...f.options, store: new OrcadOutgoingCaptureStore(root) })
  expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1])
  expect(f.options.store.read(identity)).toEqual(f.saved)
})
it('does not report success after authority changes during publication', async () => {
  const f = fixture()
  publish.mockImplementationOnce(async () => {
    f.options.assertAuthority.mockImplementation(() => {
      throw new Error('authority changed')
    })
    return { outcome: 'published' }
  })
  await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('authority changed')
  expect(f.options.store.read(identity)).toEqual(f.saved)
})

it('refuses missing saved evidence without contacting the destination', async () => {
  const f = fixture()
  await expect(
    publishOutgoingOrcadCapture({ ...f.options, identity: { ...identity, bridgeId: 'missing' } })
  ).rejects.toThrow('capture_missing')
  expect(publish).not.toHaveBeenCalled()
})

it.each(['before', 'during'])('retains evidence when canceled %s publication', async (when) => {
  const f = fixture()
  if (when === 'before') {
    f.controller.abort(new Error('canceled'))
  } else {
    publish.mockImplementationOnce(async () => {
      f.controller.abort(new Error('canceled'))
      return { outcome: 'published' }
    })
  }
  await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('canceled')
  expect(publish).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
  expect(f.options.store.read(identity)).toEqual(f.saved)
})

it('does not report success if saved evidence changed during publication', async () => {
  const f = fixture()
  publish.mockImplementationOnce(async () => {
    vi.spyOn(f.options.store, 'read').mockReturnValue({
      ...f.saved,
      destinationEnvironmentId: 'other'
    })
    return { outcome: 'published' }
  })
  await expect(publishOutgoingOrcadCapture(f.options)).rejects.toThrow('capture_changed')
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).toEqual(f.saved)
})
