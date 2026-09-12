import { expect, it, vi } from 'vitest'
import { captureSshPtyModelAttempt } from './ssh-pty-model-capture-attempt'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../../shared/pty-ownership-capture-wire'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'host'
}
const boundary = {
  version: 1,
  identity,
  throughSeq: 20,
  delivery: {
    id: 'pty',
    ptyIncarnation: 'incarnation',
    providerGeneration: 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'delivery',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 100,
    sentEndSu: 100,
    creditedEndSu: 100,
    generationClosed: false,
    exitPublished: false
  }
}
const model = {
  version: 1 as const,
  identity,
  throughSeq: 20,
  modelSequenceEnd: 90,
  modelData: 'retained',
  cols: 80,
  rows: 24,
  restoreMetadata: { version: 1 as const, kittyKeyboardFlags: 0, cwd: null }
}
function setup() {
  const controller = new AbortController()
  const request = vi
    .fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>()
    .mockResolvedValueOnce({ version: 1, captureToken: 'capture' })
    .mockResolvedValueOnce({ version: 1, boundary })
    .mockResolvedValueOnce({ version: 1, boundary })
    .mockResolvedValue({ version: 1, released: true })
  const serializeSshPtyOwnershipCapture = vi.fn(async () => model)
  const options = {
    capabilities: { captureBoundaryVersion: 1 as const },
    identity,
    route: { ptyId: 'ssh:target@@pty', providerGeneration: 42 },
    request,
    runtime: { serializeSshPtyOwnershipCapture },
    signal: controller.signal,
    requestId: 'request',
    persistBeforeSelection: vi.fn(async () => {})
  }
  return { options, request, serializeSshPtyOwnershipCapture, controller }
}

it('brackets serialization with exact host evidence and releases the token before returning', async () => {
  const fixture = setup()
  expect(await captureSshPtyModelAttempt(fixture.options)).toEqual({ boundary, model })
  expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.release
  ])
  expect(fixture.serializeSshPtyOwnershipCapture).toHaveBeenCalledWith(
    boundary,
    fixture.options.route,
    fixture.controller.signal
  )
})

it('selects the exact validated model before releasing capture', async () => {
  const fixture = setup()
  const selection = {
    version: 1,
    boundary,
    modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, 20)
  }
  fixture.request.mockReset().mockImplementation(async (method) => {
    if (method === methods.begin) {
      return { version: 1, captureToken: 'capture' }
    }
    if (method === methods.inspect) {
      return { version: 1, boundary }
    }
    if (method === methods.select) {
      expect(fixture.options.persistBeforeSelection).toHaveBeenCalledExactlyOnceWith({
        model,
        selection
      })
      return { version: 1, baseline: selection }
    }
    return { version: 1, released: true }
  })
  const result = await captureSshPtyModelAttempt({
    ...fixture.options,
    selectBaseline: true,
    capabilities: { captureBoundaryVersion: 1, captureSelectionVersion: 1 }
  })
  expect(result).toEqual({ boundary, model, selection })
  expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
    methods.begin,
    methods.inspect,
    methods.inspect,
    methods.select,
    methods.release
  ])
  expect(fixture.request).toHaveBeenCalledWith(methods.select, {
    version: 1,
    captureToken: 'capture',
    baseline: selection
  })
})

it('refuses requested selection on a capture-only host before contacting it', async () => {
  const fixture = setup()
  await expect(
    captureSshPtyModelAttempt({ ...fixture.options, selectBaseline: true })
  ).rejects.toThrow('unsupported')
  expect(fixture.request).not.toHaveBeenCalled()
})

it('requires persistence before requesting a selected baseline', async () => {
  const f = setup()
  await expect(
    captureSshPtyModelAttempt({
      ...f.options,
      persistBeforeSelection: undefined,
      selectBaseline: true,
      capabilities: { captureBoundaryVersion: 1, captureSelectionVersion: 1 }
    })
  ).rejects.toThrow('persistence_required')
  expect(f.request).not.toHaveBeenCalled()
})

it.each(['write-failure', 'canceled'] as const)(
  'does not select after %s during persistence',
  async (failure) => {
    const f = setup()
    f.options.persistBeforeSelection.mockImplementationOnce(async () => {
      if (failure === 'write-failure') {
        throw new Error('disk full')
      }
      f.controller.abort()
    })
    await expect(
      captureSshPtyModelAttempt({
        ...f.options,
        selectBaseline: true,
        capabilities: { captureBoundaryVersion: 1, captureSelectionVersion: 1 }
      })
    ).rejects.toThrow()
    expect(f.options.persistBeforeSelection).toHaveBeenCalledOnce()
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      methods.begin,
      methods.inspect,
      methods.inspect,
      methods.release
    ])
  }
)

it('rejects a changed selection receipt and still releases the token', async () => {
  const fixture = setup()
  fixture.request.mockReset().mockImplementation(async (method) => {
    if (method === methods.begin) {
      return { version: 1, captureToken: 'capture' }
    }
    if (method === methods.inspect) {
      return { version: 1, boundary }
    }
    if (method === methods.select) {
      return { version: 1, baseline: { version: 1, boundary, modelSha256: 'b'.repeat(64) } }
    }
    return { version: 1, released: true }
  })
  await expect(
    captureSshPtyModelAttempt({
      ...fixture.options,
      selectBaseline: true,
      capabilities: { captureBoundaryVersion: 1, captureSelectionVersion: 1 }
    })
  ).rejects.toThrow('selection_mismatch')
  expect(fixture.request.mock.lastCall?.[0]).toBe(methods.release)
})

it('does not contact or serialize a host that has not advertised capture support', async () => {
  const fixture = setup()
  await expect(captureSshPtyModelAttempt({ ...fixture.options, capabilities: {} })).rejects.toThrow(
    'unsupported'
  )
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.serializeSshPtyOwnershipCapture).not.toHaveBeenCalled()
})

it('rejects a changed host boundary after serialization and still releases', async () => {
  const fixture = setup()
  fixture.request
    .mockReset()
    .mockResolvedValueOnce({ version: 1, captureToken: 'capture' })
    .mockResolvedValueOnce({ version: 1, boundary })
    .mockResolvedValueOnce({ version: 1, boundary: { ...boundary, throughSeq: 21 } })
    .mockResolvedValue({ version: 1, released: true })
  await expect(captureSshPtyModelAttempt(fixture.options)).rejects.toThrow('boundary_changed')
  expect(fixture.request.mock.lastCall?.[0]).toBe(methods.release)
})

it('releases after cancellation following a successful begin response', async () => {
  const fixture = setup()
  fixture.request
    .mockReset()
    .mockImplementationOnce(async () => {
      fixture.controller.abort()
      return { version: 1, captureToken: 'capture' }
    })
    .mockResolvedValue({ version: 1, released: true })
  await expect(captureSshPtyModelAttempt(fixture.options)).rejects.toThrow()
  expect(fixture.serializeSshPtyOwnershipCapture).not.toHaveBeenCalled()
  expect(fixture.request.mock.lastCall?.[0]).toBe(methods.release)
})

it('retains both errors when capture and cleanup fail', async () => {
  const fixture = setup()
  fixture.request
    .mockReset()
    .mockResolvedValueOnce({ version: 1, captureToken: 'capture' })
    .mockResolvedValueOnce({ version: 1, boundary: null })
    .mockRejectedValueOnce(new Error('disconnected'))
  await expect(captureSshPtyModelAttempt(fixture.options)).rejects.toMatchObject({
    message: 'pty_ownership_capture_and_release_failed',
    errors: [
      expect.objectContaining({ message: 'pty_ownership_capture_not_ready' }),
      expect.objectContaining({ message: 'disconnected' })
    ]
  })
})
