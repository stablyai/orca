import { beforeEach, expect, it, vi } from 'vitest'
import { inspectOrcadLiveSourceOutputSettlements } from './orcad-live-source-output-settlement'

const intake = vi.hoisted(() => ({ checkpoints: vi.fn(), settle: vi.fn() }))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  getSshPtyAcceptedSourceCheckpoints: intake.checkpoints,
  requireSshPtyLiveSourceSettlement: intake.settle
}))
const source = {
  ptyId: 'ssh:target:terminal',
  providerGeneration: 3,
  identity: {
    bridgeId: 'bridge',
    terminalId: 'terminal',
    incarnationId: 'incarnation',
    sourceOwnerGeneration: 1,
    ownerLease: 'lease',
    destinationRuntimeId: 'destination'
  }
}
const checkpoint = {
  id: source.ptyId,
  providerGeneration: 3,
  clientGeneration: 2,
  ownerGeneration: 1,
  ptyIncarnation: 'incarnation',
  deliveryToken: 'token',
  acceptedSourceEndSu: 8
}
beforeEach(() => {
  intake.checkpoints.mockReset().mockReturnValue([checkpoint])
  intake.settle.mockReset().mockReturnValue(Object.freeze({ throughSourceEndSu: 8 }))
})

it('checks output on both sides of the final authority revalidation', () => {
  const assertCurrent = vi.fn()
  const result = inspectOrcadLiveSourceOutputSettlements([source], assertCurrent)
  expect(assertCurrent).toHaveBeenCalledTimes(2)
  expect(intake.checkpoints).toHaveBeenCalledTimes(2)
  expect(intake.checkpoints).toHaveBeenCalledWith(source.providerGeneration)
  expect(intake.settle).toHaveBeenCalledTimes(2)
  expect(result).toEqual([{ throughSourceEndSu: 8 }])
  expect(Object.isFrozen(result)).toBe(true)
})

it.each([
  [],
  [checkpoint, checkpoint],
  [{ ...checkpoint, ptyIncarnation: 'replacement' }],
  [{ ...checkpoint, providerGeneration: 4 }]
])('refuses absent, duplicate or replaced output evidence %j', (...records) => {
  // it.each expands array rows into positional arguments.
  intake.checkpoints.mockReturnValue(records)
  expect(() => inspectOrcadLiveSourceOutputSettlements([source], vi.fn())).toThrow(
    'identity_unverifiable'
  )
})

it.each([
  { clientGeneration: 99 },
  { ownerGeneration: 99 },
  { deliveryToken: 'replacement' },
  { acceptedSourceEndSu: 9 }
])('refuses stream drift during authority validation %j', (change) => {
  const assertCurrent = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      intake.checkpoints.mockReturnValue([{ ...checkpoint, ...change }])
    })
  expect(() => inspectOrcadLiveSourceOutputSettlements([source], assertCurrent)).toThrow(
    'output_changed'
  )
})

it('refuses a new second incarnation during the final authority check', () => {
  const assertCurrent = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      intake.checkpoints.mockReturnValue([
        checkpoint,
        { ...checkpoint, ptyIncarnation: 'replacement' }
      ])
    })
  expect(() => inspectOrcadLiveSourceOutputSettlements([source], assertCurrent)).toThrow(
    'identity_unverifiable'
  )
})

it('ignores unrelated panes and rejects a failed settlement in the requested cohort', () => {
  intake.checkpoints.mockReturnValue([checkpoint, { ...checkpoint, id: 'other-host-pane' }])
  expect(inspectOrcadLiveSourceOutputSettlements([source], vi.fn())).toHaveLength(1)
  intake.settle.mockImplementationOnce(() => {
    throw new Error('pending consumer')
  })
  expect(() => inspectOrcadLiveSourceOutputSettlements([source], vi.fn())).toThrow(
    'pending consumer'
  )
})

it('propagates lost authority without inspecting output', () => {
  expect(() =>
    inspectOrcadLiveSourceOutputSettlements([source], () => {
      throw new Error('aborted')
    })
  ).toThrow('aborted')
  expect(intake.checkpoints).not.toHaveBeenCalled()
})
