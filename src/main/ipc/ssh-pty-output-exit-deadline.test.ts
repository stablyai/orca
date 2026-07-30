import { describe, expect, it, vi } from 'vitest'
import type { RemoteTerminalSourceRangeStreamIdentity } from '../runtime/remote-terminal-source-range-consumer'
import {
  SshPtyOutputIntake,
  type SshPtyOutputIntakeDependencies,
  type SshPtyOutputReceipt
} from './ssh-pty-output-intake'
import type { SshPtySourceCancellationProof } from './ssh-pty-output-intake-contract'

type ExitDeadlineHarness = Readonly<{
  intake: SshPtyOutputIntake
  dependencies: SshPtyOutputIntakeDependencies
  cancelSourceDelivery: ReturnType<typeof vi.fn>
  releaseExit: ReturnType<typeof vi.fn>
  exits: string[]
}>

const stream: RemoteTerminalSourceRangeStreamIdentity = {
  ptyId: 'pty-1',
  consumerId: 'remote-1',
  streamGeneration: 'stream-1'
}

function createHarness(
  cancelSourceDelivery: NonNullable<SshPtyOutputIntakeDependencies['cancelSourceDelivery']>
): ExitDeadlineHarness {
  const exits: string[] = []
  const releaseExit = vi.fn()
  const cancellation = vi.fn(cancelSourceDelivery)
  const dependencies: SshPtyOutputIntakeDependencies = {
    getModelSequence: () => 0,
    acceptModel: (event) => ({ sequence: event.rawLength, completion: Promise.resolve() }),
    project: vi.fn(),
    prepareExit: vi.fn(() => releaseExit),
    finalizeExit: () => exits.push('exit'),
    pauseProvider: vi.fn(() => true),
    resumeProvider: vi.fn(),
    closeProvider: vi.fn(),
    cancelSourceDelivery: cancellation
  }
  return {
    intake: new SshPtyOutputIntake(dependencies, {
      exitBarrierMs: 10,
      exitCancellationProofMs: 100
    }),
    dependencies,
    cancelSourceDelivery: cancellation,
    releaseExit,
    exits
  }
}

async function publishSource(harness: ExitDeadlineHarness): Promise<SshPtyOutputReceipt> {
  const remote = harness.intake.getRemoteSourceRangeConsumerHooks()
  expect(remote.attach(stream)).toBe(true)
  const receipt = await harness.intake.acceptData({
    id: 'pty-1',
    data: 'aaaa',
    providerGeneration: 1,
    ptyIncarnation: 'incarnation-1',
    rawLength: 4,
    transformed: false,
    source: {
      spanId: 'span-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1',
      sourceStartSu: 0,
      sourceEndSu: 4
    }
  })
  harness.intake.publishProjectionPrefix([receipt.projection.identity.projectionSemanticsId], 4, 4)
  return receipt
}

function acceptExit(harness: ExitDeadlineHarness) {
  return harness.intake.acceptExit({
    id: 'pty-1',
    code: 0,
    providerGeneration: 1,
    ptyIncarnation: 'incarnation-1'
  })
}

describe('SshPtyOutputExitDeadline', () => {
  it('transfers published projections before cancellation proof reclaims their spans', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness(async () => ({ sentEndSu: 4, creditedEndSu: 0 }))
      const receipt = await publishSource(harness)
      const exitResult = acceptExit(harness).then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )

      await vi.advanceTimersByTimeAsync(10)

      expect(await exitResult).toEqual({ ok: true })
      expect(harness.cancelSourceDelivery).toHaveBeenCalledOnce()
      expect(harness.dependencies.closeProvider).not.toHaveBeenCalled()
      expect(harness.dependencies.prepareExit).toHaveBeenCalledOnce()
      expect(harness.releaseExit).toHaveBeenCalledOnce()
      expect(harness.exits).toEqual(['exit'])
      expect(harness.intake.getDebugSnapshot()).toMatchObject({
        projection: { records: 0 },
        source: { openedTokens: 0, ptyIdentities: 0 },
        exitBarriers: 0
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.exits).toEqual(['exit'])
      expect(() =>
        harness.intake
          .getRemoteSourceRangeConsumerHooks()
          .settle(stream, [receipt.projection.desktopSpan!])
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('generation close fences a pending cancellation proof from final exit', async () => {
    vi.useFakeTimers()
    try {
      let resolveCancellation!: (proof: SshPtySourceCancellationProof) => void
      const cancellation = new Promise<SshPtySourceCancellationProof>((resolve) => {
        resolveCancellation = resolve
      })
      const harness = createHarness(() => cancellation)
      await publishSource(harness)
      const exitResult = acceptExit(harness).then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.advanceTimersByTimeAsync(10)
      expect(harness.cancelSourceDelivery).toHaveBeenCalledOnce()

      harness.intake.closeGeneration(1, 'provider-closed')
      const closed = await exitResult
      expect(closed.ok).toBe(false)
      expect(closed.ok ? '' : closed.error.message).toContain('provider-closed')
      resolveCancellation({ sentEndSu: 4, creditedEndSu: 0 })
      await vi.advanceTimersByTimeAsync(0)

      expect(harness.exits).toEqual([])
      expect(harness.dependencies.closeProvider).not.toHaveBeenCalled()
      expect(harness.intake.getDebugSnapshot()).toMatchObject({
        projection: { records: 0 },
        source: { openedTokens: 0, ptyIdentities: 0 },
        exitBarriers: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
