import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  assertCurrent: vi.fn(),
  checkpointRead: vi.fn(),
  checkpointPersist: vi.fn(),
  receiptRead: vi.fn(),
  receiptPersist: vi.fn(),
  preparationPersist: vi.fn(),
  create: vi.fn(),
  order: [] as string[]
}))
vi.mock('./orcad-live-runtime-restart-readiness', () => ({
  withOrcadLiveRuntimeRestartReadiness: (
    _options: unknown,
    operation: (value: unknown) => unknown
  ) =>
    operation({
      record: {
        identity: { bridgeId: 'record' },
        release: { cutover: { liveTerminalBindings: [{ identity: { bridgeId: 'terminal' } }] } }
      },
      outputEvidence: { settlements: [] },
      assertCurrent: f.assertCurrent
    })
}))
vi.mock('./orcad-live-runtime-cleanup-checkpoint', () => ({
  OrcadLiveRuntimeCleanupCheckpointStore: class {
    read = f.checkpointRead
    persist = f.checkpointPersist
  }
}))
vi.mock('./orcad-live-source-cancellation-receipt', () => ({
  OrcadLiveSourceCancellationReceiptStore: class {
    read = f.receiptRead
    persist = f.receiptPersist
  }
}))
vi.mock('./orcad-live-source-completion-preparation', () => ({
  createOrcadLiveSourceCompletionPreparation: f.create,
  OrcadLiveSourceCompletionPreparationStore: class {
    persist = f.preparationPersist
  }
}))
import { prepareOrcadLiveSourceCompletion } from './orcad-live-source-completion'

const options = { profileDirectory: 'unused' } as Parameters<
  typeof prepareOrcadLiveSourceCompletion
>[0]
beforeEach(() => {
  vi.resetAllMocks()
  f.order.length = 0
  f.checkpointRead.mockReturnValue({ checkpoint: true })
  f.receiptRead.mockReturnValue({ receipt: true })
  f.create.mockImplementation(({ checkpoint, receipts }) => ({ checkpoint, receipts }))
  f.checkpointPersist.mockImplementation(() => f.order.push('checkpoint'))
  f.receiptPersist.mockImplementation(() => f.order.push('receipt'))
  f.preparationPersist.mockImplementation((value) => {
    f.order.push('preparation')
    return value
  })
})

it('reflushes checkpoint and complete receipt cohort before preparation', async () => {
  await expect(prepareOrcadLiveSourceCompletion(options)).resolves.toEqual({
    checkpoint: { checkpoint: true },
    receipts: [{ receipt: true }]
  })
  expect(f.order).toEqual(['checkpoint', 'receipt', 'preparation'])
  expect(f.assertCurrent).toHaveBeenCalled()
})

it.each(['checkpoint', 'receipt'] as const)(
  'does not prepare after %s reflush failure',
  async (stage) => {
    const persist = stage === 'checkpoint' ? f.checkpointPersist : f.receiptPersist
    persist.mockImplementation(() => {
      throw new Error('disk failure')
    })
    await expect(prepareOrcadLiveSourceCompletion(options)).rejects.toThrow('disk failure')
    expect(f.preparationPersist).not.toHaveBeenCalled()
  }
)

it('refuses cohort changes during reflush', async () => {
  f.receiptPersist.mockImplementation(() => f.receiptRead.mockReturnValue({ replacement: true }))
  await expect(prepareOrcadLiveSourceCompletion(options)).rejects.toThrow('evidence_changed')
  expect(f.preparationPersist).not.toHaveBeenCalled()
})

it('refuses lost authority before any persistence', async () => {
  f.assertCurrent.mockImplementation(() => {
    throw new Error('authority lost')
  })
  await expect(prepareOrcadLiveSourceCompletion(options)).rejects.toThrow('authority lost')
  expect(f.checkpointPersist).not.toHaveBeenCalled()
  expect(f.receiptPersist).not.toHaveBeenCalled()
  expect(f.preparationPersist).not.toHaveBeenCalled()
})

it('does not acknowledge preparation when authority is lost during its write', async () => {
  f.preparationPersist.mockImplementation(() => {
    f.assertCurrent.mockImplementation(() => {
      throw new Error('authority lost')
    })
    return {}
  })
  await expect(prepareOrcadLiveSourceCompletion(options)).rejects.toThrow('authority lost')
})
