import { beforeEach, expect, it, vi } from 'vitest'
import { requireSshPtyCaptureModelCheckpoint } from './ssh-pty-capture-model-checkpoint'
import { getSshPtyAcceptedSourceCheckpoints } from '../ipc/ssh-pty-output-intake-registry'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'

vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  getSshPtyAcceptedSourceCheckpoints: vi.fn()
}))
const identity = {
  bridgeId: 'bridge',
  terminalId: 'relay-pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'host'
}
const boundary = parsePtyOwnershipCaptureBoundary(
  {
    version: 1,
    identity,
    throughSeq: 20,
    delivery: {
      id: 'relay-pty',
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
  },
  identity
)
const route = { ptyId: 'ssh:target:relay-pty', providerGeneration: 42 }
const checkpoint = {
  id: route.ptyId,
  providerGeneration: 42,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation',
  deliveryToken: 'delivery',
  acceptedSourceEndSu: 100
}
beforeEach(() => {
  vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReset().mockReturnValue([checkpoint])
})

it('binds the host stream to the app-local route without equating different sequence domains', () => {
  const result = requireSshPtyCaptureModelCheckpoint(boundary, route)
  expect(result).toEqual(checkpoint)
  expect(result).not.toBe(checkpoint)
  expect(Object.isFrozen(result)).toBe(true)
  expect(getSshPtyAcceptedSourceCheckpoints).toHaveBeenCalledWith(42)
})

it.each([
  { id: 'other' },
  { providerGeneration: 43 },
  { clientGeneration: 4 },
  { ownerGeneration: 4 },
  { ptyIncarnation: 'other' },
  { deliveryToken: 'other' },
  { acceptedSourceEndSu: 99 },
  { acceptedSourceEndSu: 101 }
])('refuses mismatched or non-exact accepted-model evidence: %j', (patch) => {
  vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([{ ...checkpoint, ...patch }])
  expect(() => requireSshPtyCaptureModelCheckpoint(boundary, route)).toThrow(
    'checkpoint_unavailable'
  )
})

it.each([{ checkpoints: [] }, { checkpoints: [checkpoint, checkpoint] }])(
  'refuses missing or ambiguous checkpoints',
  ({ checkpoints }) => {
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue(checkpoints)
    expect(() => requireSshPtyCaptureModelCheckpoint(boundary, route)).toThrow(
      'checkpoint_unavailable'
    )
  }
)
