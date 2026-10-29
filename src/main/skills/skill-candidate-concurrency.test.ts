import { describe, expect, it } from 'vitest'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'

describe('runSkillCandidateTasks', () => {
  it('bounds concurrency and preserves task order', async () => {
    const gates = Array.from({ length: 12 }, () => Promise.withResolvers<number>())
    const fifthStarted = Promise.withResolvers<void>()
    const started: number[] = []
    let active = 0
    let maxActive = 0
    const pending = runSkillCandidateTasks(
      gates.map((gate, index) => async () => {
        started.push(index)
        if (index === 4) {
          fifthStarted.resolve()
        }
        active += 1
        maxActive = Math.max(maxActive, active)
        const result = await gate.promise
        active -= 1
        return result
      })
    )

    expect(started).toEqual([0, 1, 2, 3])
    gates[3].resolve(3)
    await fifthStarted.promise
    expect(started).toEqual([0, 1, 2, 3, 4])
    gates.forEach((gate, index) => gate.resolve(index))

    expect(await pending).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
  })
})
