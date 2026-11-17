import { describe, expect, it } from 'vitest'
import { awaitInFlightWake, WorkspaceSleepRequests, type VmOperation } from './recipe-vm-operations'

describe('awaitInFlightWake', () => {
  it('answers at once for a VM that is up or asleep, without starting anything', async () => {
    const sleeps = new WorkspaceSleepRequests()
    await expect(awaitInFlightWake([], false, sleeps, 'w', 1000)).resolves.toBe('up')
    await expect(awaitInFlightWake([], true, sleeps, 'w', 1000)).resolves.toBe('asleep')
  })

  it('waits for the wake already in flight', async () => {
    let finish = (): void => {}
    const settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending: VmOperation[] = [{ kind: 'wake', settled }]
    const answer = awaitInFlightWake(pending, false, new WorkspaceSleepRequests(), 'w', 5000)
    finish()
    await expect(answer).resolves.toBe('up')
  })

  it('ends slept when a Sleep is asked for while it waits, and waking when the hold runs out', async () => {
    const sleeps = new WorkspaceSleepRequests()
    const never: VmOperation[] = [{ kind: 'wake', settled: new Promise(() => {}) }]
    const slept = awaitInFlightWake(never, false, sleeps, 'w', 5000)
    sleeps.noteRequested('w')
    await expect(slept).resolves.toBe('slept')
    await expect(awaitInFlightWake(never, false, sleeps, 'w', 5)).resolves.toBe('waking')
  })
})
