import { describe, expect, it, vi } from 'vitest'
import type { SshPtyOutputDataEvent } from './ssh-pty-output-intake'
import {
  createSshPtyOutputIntakeHarness as createHarness,
  sshPtyOutputEvent as event
} from './__tests__/ssh-pty-output-intake-test-harness'

// Production-shaped ids: bare relay id on the wire side, prefixed app id in intake.
const APP_ID = 'ssh:conn@@pty-1'
const prodEvent = (overrides: Partial<SshPtyOutputDataEvent> = {}): SshPtyOutputDataEvent =>
  event({
    id: APP_ID,
    source: {
      relayPtyId: 'pty-1',
      spanId: 'span-a',
      clientGeneration: 3,
      ownerGeneration: 4,
      deliveryToken: 'delivery-token-1',
      sourceStartSu: 0,
      sourceEndSu: 4
    },
    ...overrides
  })

describe('SshPtyOutputModelMigration', () => {
  it('fences an in-flight admission when relay and app pty ids differ', async () => {
    const harness = createHarness()
    const first = harness.intake.acceptData(prodEvent({ data: 'aaaa' }))
    harness.completions[0]!.resolve()
    await first
    const second = harness.intake.acceptData(
      prodEvent({
        data: 'bbbb',
        source: {
          relayPtyId: 'pty-1',
          spanId: 'span-b',
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'delivery-token-1',
          sourceStartSu: 4,
          sourceEndSu: 8
        }
      })
    )

    const migration = harness.intake.beginGenerationMigration(1)
    expect([...migration.byPty.keys()]).toEqual([APP_ID])
    const result = migration.byPty.get(APP_ID)
    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toBe('pending')
    await expect(Promise.race([migration.completion, Promise.resolve('pending')])).resolves.toBe(
      'pending'
    )
    expect(harness.intake.getAcceptedSourceCheckpoints(1)[0]).toMatchObject({
      id: APP_ID,
      acceptedSourceEndSu: 4
    })

    harness.completions[1]!.resolve()
    await expect(second).resolves.toMatchObject({ sequence: 8 })
    await expect(result).resolves.toMatchObject({
      status: 'settled',
      checkpoint: { id: APP_ID, acceptedSourceEndSu: 8 }
    })
    await migration.completion
  })

  it('targets the real pty on migration timeout with production-shaped ids', async () => {
    vi.useFakeTimers()
    try {
      const resetModelForMigration = vi.fn()
      const harness = createHarness({ resetModelForMigration })
      const receipt = harness.intake.acceptData(prodEvent())
      const migration = harness.intake.beginGenerationMigration(1, 10_000)

      await vi.advanceTimersByTimeAsync(10_000)

      await expect(migration.byPty.get(APP_ID)).resolves.toEqual({
        status: 'checkpoint-unavailable',
        reason: 'timeout'
      })
      await expect(receipt).rejects.toThrow('ssh_model_migration_timeout')
      expect(resetModelForMigration).toHaveBeenCalledOnce()
      expect(resetModelForMigration).toHaveBeenCalledWith(1, APP_ID)
      harness.completions[0]!.resolve()
      await migration.completion
    } finally {
      vi.useRealTimers()
    }
  })

  it('fences a running source span before exporting its migration checkpoint', async () => {
    const harness = createHarness()
    const first = harness.intake.acceptData(
      event({
        data: 'aaaa',
        source: {
          spanId: 'span-a',
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'delivery-token-1',
          sourceStartSu: 0,
          sourceEndSu: 4
        }
      })
    )
    harness.completions[0]!.resolve()
    await first
    const second = harness.intake.acceptData(
      event({
        data: 'bbbb',
        source: {
          spanId: 'span-b',
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'delivery-token-1',
          sourceStartSu: 4,
          sourceEndSu: 8
        }
      })
    )

    const migration = harness.intake.beginGenerationMigration(1)
    const result = migration.byPty.get('pty-1')
    expect(result).toBeDefined()
    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toBe('pending')
    expect(harness.intake.getAcceptedSourceCheckpoints(1)[0]?.acceptedSourceEndSu).toBe(4)

    harness.completions[1]!.resolve()
    await expect(second).resolves.toMatchObject({ sequence: 8 })
    await expect(result).resolves.toMatchObject({
      status: 'settled',
      checkpoint: { acceptedSourceEndSu: 8 }
    })
    expect(harness.order.filter((entry) => entry === 'project:bbbb')).toHaveLength(1)
    await migration.completion
  })

  it('times out one migration, resets its model, and releases retained admission once', async () => {
    vi.useFakeTimers()
    try {
      const resetModelForMigration = vi.fn()
      const harness = createHarness({ resetModelForMigration })
      const receipt = harness.intake.acceptData(
        event({
          source: {
            spanId: 'span-b',
            clientGeneration: 3,
            ownerGeneration: 4,
            deliveryToken: 'delivery-token-1',
            sourceStartSu: 0,
            sourceEndSu: 4
          }
        })
      )
      const migration = harness.intake.beginGenerationMigration(1, 10_000)
      const result = migration.byPty.get('pty-1')

      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toMatchObject({ status: 'checkpoint-unavailable' })
      await expect(receipt).rejects.toThrow('ssh_model_migration_timeout')
      expect(resetModelForMigration).toHaveBeenCalledOnce()
      expect(resetModelForMigration).toHaveBeenCalledWith(1, 'pty-1')
      expect(harness.intake.getDebugSnapshot().model).toMatchObject({
        sourceUnits: 0,
        bytes: 0,
        migratingPtys: 1
      })
      expect(vi.getTimerCount()).toBe(0)
      harness.completions[0]!.resolve()
      await Promise.resolve()
      expect(resetModelForMigration).toHaveBeenCalledOnce()
      harness.intake.closeGeneration(1, 'connection_lost')
      expect(harness.intake.getDebugSnapshot().model.migratingPtys).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains a running callback failure to its migrating PTY', async () => {
    vi.useFakeTimers()
    try {
      const resetModelForMigration = vi.fn()
      const harness = createHarness({ resetModelForMigration })
      const sibling = harness.intake.acceptData(
        event({
          id: 'pty-sibling',
          ptyIncarnation: 'incarnation-sibling',
          source: {
            spanId: 'span-sibling',
            clientGeneration: 3,
            ownerGeneration: 4,
            deliveryToken: 'delivery-sibling',
            sourceStartSu: 0,
            sourceEndSu: 4
          }
        })
      )
      harness.completions[0]!.resolve()
      await sibling
      const failed = harness.intake.acceptData(
        event({
          id: 'pty-failed',
          ptyIncarnation: 'incarnation-failed',
          source: {
            spanId: 'span-failed',
            clientGeneration: 3,
            ownerGeneration: 4,
            deliveryToken: 'delivery-failed',
            sourceStartSu: 0,
            sourceEndSu: 4
          }
        })
      )
      const migration = harness.intake.beginGenerationMigration(1)

      harness.completions[1]!.reject(new Error('emulator failed'))

      await expect(failed).rejects.toMatchObject({
        message: 'emulator failed',
        code: 'ssh_model_migration_completion_failed'
      })
      await expect(migration.byPty.get('pty-failed')).resolves.toEqual({
        status: 'checkpoint-unavailable',
        reason: 'completion-failed'
      })
      await expect(migration.byPty.get('pty-sibling')).resolves.toMatchObject({
        status: 'settled',
        checkpoint: { id: 'pty-sibling', acceptedSourceEndSu: 4 }
      })
      await migration.completion
      expect(resetModelForMigration).toHaveBeenCalledTimes(1)
      expect(resetModelForMigration).toHaveBeenCalledWith(1, 'pty-failed')
      expect(harness.dependencies.closeProvider).not.toHaveBeenCalled()
      expect(harness.intake.getAcceptedSourceCheckpoints(1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'pty-failed', acceptedSourceEndSu: 0 }),
          expect.objectContaining({ id: 'pty-sibling', acceptedSourceEndSu: 4 })
        ])
      )
      expect(harness.intake.getDebugSnapshot().model).toMatchObject({
        sourceUnits: 0,
        bytes: 0,
        pressureFrames: 0,
        migratingPtys: 2
      })
      expect(vi.getTimerCount()).toBe(0)

      harness.completions[1]!.resolve()
      await Promise.resolve()
      expect(resetModelForMigration).toHaveBeenCalledTimes(1)
      expect(harness.dependencies.closeProvider).not.toHaveBeenCalled()
      expect(
        harness.intake
          .getAcceptedSourceCheckpoints(1)
          .find((checkpoint) => checkpoint.id === 'pty-failed')?.acceptedSourceEndSu
      ).toBe(0)

      const unrelated = harness.intake.acceptData(
        event({
          id: 'pty-unrelated',
          providerGeneration: 2,
          ptyIncarnation: 'incarnation-unrelated'
        })
      )
      harness.completions[2]!.resolve()
      await expect(unrelated).resolves.toMatchObject({ providerGeneration: 2 })
      expect(harness.dependencies.closeProvider).not.toHaveBeenCalled()
      harness.intake.closeGeneration(1, 'connection_lost')
      harness.intake.closeGeneration(2, 'connection_lost')
      expect(harness.intake.getDebugSnapshot().model).toMatchObject({
        sourceUnits: 0,
        bytes: 0,
        migratingPtys: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
