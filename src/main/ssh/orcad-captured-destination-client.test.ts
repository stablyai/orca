import { beforeEach, expect, it, vi } from 'vitest'
import { prepareRemoteOrcadCapturedDestination } from './orcad-captured-destination-client'
import {
  identity,
  request,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { encodePairingOffer } from '../../shared/pairing'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))
beforeEach(() => send.mockReset())

function fixture() {
  const model = {
    version: 1,
    identity,
    throughSeq: 1,
    modelSequenceEnd: 100,
    modelData: 'preserved',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1 }
  }
  const options = {
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:1234',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }),
    runtimeId: identity.destinationRuntimeId,
    surfaceBinding: preparation.surfacePublication.surfaceBinding,
    capture: {
      identity,
      model,
      signal: new AbortController().signal,
      source: {
        version: 1,
        proof: request(),
        endpoint: '/source.sock',
        incumbentVersion: 'build',
        endpointCredential: 'credential'
      }
    }
  }
  const result = {
    version: 1,
    outcome: 'published',
    identity,
    importReceipt: {
      version: 1,
      identity,
      throughSeq: 1,
      modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, 1)
    },
    publicationReceipt: {
      version: 1,
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      publicationReceiptId: 'publication',
      publishedAt: new Date(0).toISOString(),
      commitReceipt: {
        receiptId: 'commit',
        bridgeId: identity.bridgeId,
        acceptedSourceEndSeq: 1,
        committedAt: new Date(0).toISOString()
      },
      surfaceBinding: options.surfaceBinding
    }
  }
  const response = { ok: true, result, _meta: { runtimeId: identity.destinationRuntimeId } }
  send.mockResolvedValue(response)
  return { options, response }
}

it('accepts exact publication evidence and strips unknown response fields', async () => {
  const f = fixture()
  send.mockResolvedValue({
    ...f.response,
    result: { ...f.response.result, secret: 'not-returned' }
  })
  expect(await prepareRemoteOrcadCapturedDestination(f.options)).toEqual(f.response.result)
  expect(send).toHaveBeenCalledTimes(1)
})

it('refuses malformed catalog admission before sending', async () => {
  const f = fixture()
  await expect(
    prepareRemoteOrcadCapturedDestination({
      ...f.options,
      capture: { ...f.options.capture, catalogAdmission: { version: 1 } }
    })
  ).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

function catalogFixture() {
  const f = fixture()
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const catalogAdmission = parseOrcadTerminalLayoutAdmission({
    version: 1,
    manifest,
    bindings: [{ identity, surfaceBinding: f.options.surfaceBinding }]
  })
  return {
    ...f,
    options: { ...f.options, capture: { ...f.options.capture, catalogAdmission } },
    probe: { ok: true, result: { version: 1, catalogPublication: 1 }, _meta: f.response._meta },
    result: {
      ...f.response.result,
      version: 2,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    }
  }
}

it('negotiates exact host support and sends required version 2', async () => {
  const f = catalogFixture()
  send.mockResolvedValueOnce(f.probe).mockResolvedValueOnce({ ...f.response, result: f.result })
  await expect(prepareRemoteOrcadCapturedDestination(f.options)).resolves.toMatchObject({
    outcome: 'published'
  })
  expect(send.mock.calls[0][1]).toBe('pty.ownershipTransfer.capturedDestinationCapabilities')
  expect(send.mock.calls[1][2]).toMatchObject({
    version: 2,
    catalogAdmission: f.options.capture.catalogAdmission
  })
})

it('cancels after support response without sending prepare', async () => {
  const f = catalogFixture()
  const controller = new AbortController()
  send.mockImplementationOnce(async () => {
    controller.abort()
    return f.probe
  })
  await expect(
    prepareRemoteOrcadCapturedDestination({
      ...f.options,
      capture: { ...f.options.capture, signal: controller.signal }
    })
  ).rejects.toThrow()
  expect(send).toHaveBeenCalledOnce()
})

it.each(['runtime-changed', 'support-withdrawn'])(
  'refuses %s after successful negotiation without fallback',
  async (kind) => {
    const f = catalogFixture()
    send
      .mockResolvedValueOnce(f.probe)
      .mockResolvedValueOnce(
        kind === 'support-withdrawn'
          ? { ok: false, error: { code: 'internal_error' } }
          : { ...f.response, result: f.result, _meta: { runtimeId: 'replacement' } }
      )
    await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][2].version).toBe(2)
  }
)

it('captures catalog authority before the asynchronous probe', async () => {
  const f = catalogFixture()
  const original = structuredClone(f.options.capture.catalogAdmission)
  send
    .mockImplementationOnce(async () => {
      f.options.capture.catalogAdmission.manifest.migrationId = 'mutated'
      return f.probe
    })
    .mockResolvedValueOnce({ ...f.response, result: f.result })
  await prepareRemoteOrcadCapturedDestination(f.options)
  expect(send.mock.calls[1][2].catalogAdmission).toEqual(original)
})

it.each(['old-host', 'disabled', 'wrong-runtime', 'wrong-version'])(
  'refuses %s negotiation without sending prepare',
  async (kind) => {
    const f = catalogFixture()
    const response =
      kind === 'old-host'
        ? { ok: false, error: { code: 'method_not_found' } }
        : {
            ...f.probe,
            _meta: {
              runtimeId: kind === 'wrong-runtime' ? 'other' : identity.destinationRuntimeId
            },
            result: {
              version: kind === 'wrong-version' ? 2 : 1,
              catalogPublication: kind === 'disabled' ? null : 1
            }
          }
    send.mockResolvedValueOnce(response)
    await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow(
      'catalog_negotiation_required'
    )
    expect(send).toHaveBeenCalledOnce()
  }
)

it.each(['downgrade', 'digest', 'missing'])('refuses %s catalog success evidence', async (kind) => {
  const f = catalogFixture()
  send.mockResolvedValueOnce(f.probe).mockResolvedValueOnce({
    ...f.response,
    result: {
      ...f.result,
      version: kind === 'downgrade' ? 1 : 2,
      catalog:
        kind === 'missing'
          ? undefined
          : {
              ...f.result.catalog,
              manifestSha256: kind === 'digest' ? '0'.repeat(64) : f.result.catalog.manifestSha256
            }
    }
  })
  await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(2)
})

it.each(['runtime', 'identity', 'digest', 'cursor', 'commit', 'surface', 'outcome'] as const)(
  'rejects mismatched %s evidence',
  async (field) => {
    const f = fixture()
    const r = f.response.result
    if (field === 'runtime') {
      f.response._meta.runtimeId = 'other'
    }
    if (field === 'identity') {
      r.identity = { ...identity, ownerLease: 'other' }
    }
    if (field === 'digest') {
      r.importReceipt.modelSha256 = '0'.repeat(64)
    }
    if (field === 'cursor') {
      r.importReceipt.throughSeq = 2
    }
    if (field === 'commit') {
      r.publicationReceipt.commitReceipt.bridgeId = 'other'
    }
    if (field === 'surface') {
      r.publicationReceipt.surfaceBinding = {
        ...r.publicationReceipt.surfaceBinding,
        tabId: 'other'
      }
    }
    if (field === 'outcome') {
      r.outcome = 'complete'
    }
    await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it.each(['method_not_found', 'unauthorized', 'internal_error'])(
  'does not fall back or retry when the host returns %s',
  async (code) => {
    const f = fixture()
    send.mockResolvedValue({ ok: false, error: { code, message: 'private diagnostic' } })
    await expect(prepareRemoteOrcadCapturedDestination(f.options)).rejects.toThrow(`failed:${code}`)
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it('rejects a wrong pinned destination before contact', async () => {
  const f = fixture()
  await expect(
    prepareRemoteOrcadCapturedDestination({ ...f.options, runtimeId: 'other' })
  ).rejects.toThrow('runtime_mismatch')
  expect(send).not.toHaveBeenCalled()
})
