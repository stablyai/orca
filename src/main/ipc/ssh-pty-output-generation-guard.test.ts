import { describe, expect, it } from 'vitest'
import { SshPtyOutputGenerationGuard } from './ssh-pty-output-generation-guard'

const event = (providerGeneration: number) => ({
  id: 'pty-1',
  providerGeneration,
  ptyIncarnation: 'incarnation-1'
})

describe('SshPtyOutputGenerationGuard', () => {
  it('compacts sequential closures without weakening stale rejection', () => {
    const guard = new SshPtyOutputGenerationGuard(() => false)
    for (let generation = 1; generation <= 2_048; generation++) {
      guard.closeGeneration(generation)
    }

    expect(guard.getDebugSnapshot()).toEqual({
      closedRanges: 1,
      activeGaps: 0,
      activePtys: 0,
      sealedPtys: 0
    })
    expect(() => guard.validate(event(1_024))).toThrow('ssh_output_stale_generation')
    expect(() => guard.validate(event(2_049))).not.toThrow()
  })

  it('counts and merges out-of-order live generation gaps exactly', () => {
    const guard = new SshPtyOutputGenerationGuard(() => false)
    guard.closeGeneration(4)
    guard.closeGeneration(2)

    expect(guard.getDebugSnapshot()).toMatchObject({ closedRanges: 2, activeGaps: 2 })
    guard.closeGeneration(3)
    expect(guard.getDebugSnapshot()).toMatchObject({ closedRanges: 1, activeGaps: 1 })
    expect(() => guard.validate(event(1))).not.toThrow()
    expect(() => guard.validate(event(2))).toThrow('ssh_output_stale_generation')

    guard.closeGeneration(1)
    expect(guard.getDebugSnapshot()).toEqual({
      closedRanges: 1,
      activeGaps: 0,
      activePtys: 0,
      sealedPtys: 0
    })
  })
})
