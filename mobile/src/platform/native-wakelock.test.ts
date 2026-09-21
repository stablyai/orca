import { describe, expect, it } from 'vitest'
import { createNativeWakelockServer, type WakelockDevice } from './native-wakelock'

/** A device whose every call is resolved by the case, so an interleaving can be built by hand. */
function createGatedDevice(): {
  device: WakelockDevice
  calls: string[]
  settle: (call: string) => void
  refuse: (call: string, error: Error) => void
} {
  const calls: string[] = []
  const gates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  const gate = (call: string): Promise<void> => {
    calls.push(call)
    return new Promise<void>((resolve, reject) => {
      gates.set(call, { resolve: () => resolve(), reject })
    })
  }
  return {
    calls,
    device: {
      activate: (tag) => gate(`activate:${tag}`),
      deactivate: (tag) => gate(`deactivate:${tag}`)
    },
    settle: (call) => {
      const pending = gates.get(call)
      if (!pending) {
        throw new Error(`nothing is waiting on ${call}`)
      }
      gates.delete(call)
      pending.resolve()
    },
    refuse: (call, error) => {
      const pending = gates.get(call)
      if (!pending) {
        throw new Error(`nothing is waiting on ${call}`)
      }
      gates.delete(call)
      pending.reject(error)
    }
  }
}

/** Lets the gated calls above reach the awaits inside the server. */
const settleMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a tag that lands after the session ended', () => {
  it('keeps recording a tag whose compensating release the device refused', async () => {
    // The set means "the device still has this tag". After `activate` resolves the device has it,
    // so a compensating `deactivate` the device refuses must leave the tag recorded: nothing else
    // walks the set once `dispose` has run, and a tag recorded nowhere is a screen that stays
    // awake for the life of the app. The refusal reaches the caller so its retry path can run.
    const gated = createGatedDevice()
    const server = createNativeWakelockServer(gated.device)
    const served = server.serve({ active: true, tag: 'orca-mobile-dictation:1:a' })
    await settleMicrotasks()
    server.dispose()
    gated.settle('activate:orca-mobile-dictation:1:a')
    await settleMicrotasks()
    gated.refuse(
      'deactivate:orca-mobile-dictation:1:a',
      new Error('the device would not give the tag back')
    )
    await expect(served).rejects.toThrow('the device would not give the tag back')

    // The tag is still recorded, so a later release reaches the device rather than answering
    // "not held" without calling anything.
    const release = server.serve({ active: false, tag: 'orca-mobile-dictation:1:a' })
    await settleMicrotasks()
    expect(gated.calls).toEqual([
      'activate:orca-mobile-dictation:1:a',
      'deactivate:orca-mobile-dictation:1:a',
      'deactivate:orca-mobile-dictation:1:a'
    ])
    gated.settle('deactivate:orca-mobile-dictation:1:a')
    await expect(release).resolves.toEqual({ active: false })
  })
})

describe('a release issued while its own activate is still in flight', () => {
  it('leaves the device off, because the last request said off', async () => {
    // Without a queue the release reads `held` before the activate has recorded anything, finds
    // nothing, deactivates nothing and reports `active: false` — and then the activate lands and
    // the device stays on, holding a tag the page has already said it does not want.
    const gated = createGatedDevice()
    const server = createNativeWakelockServer(gated.device)
    const activated = server.serve({ active: true, tag: 'orca-mobile-dictation:1:b' })
    await settleMicrotasks()
    const released = server.serve({ active: false, tag: 'orca-mobile-dictation:1:b' })
    await settleMicrotasks()
    gated.settle('activate:orca-mobile-dictation:1:b')
    await settleMicrotasks()
    await expect(activated).resolves.toEqual({ active: true })
    gated.settle('deactivate:orca-mobile-dictation:1:b')
    await expect(released).resolves.toEqual({ active: false })
    expect(gated.calls).toEqual([
      'activate:orca-mobile-dictation:1:b',
      'deactivate:orca-mobile-dictation:1:b'
    ])
  })

  it('orders two tags independently, so one slow device call cannot hold up another', async () => {
    // The precondition the case above needs: the queue is per tag, not one chain for the server.
    const gated = createGatedDevice()
    const server = createNativeWakelockServer(gated.device)
    const first = server.serve({ active: true, tag: 'orca-mobile-dictation:1:c' })
    const second = server.serve({ active: true, tag: 'orca-mobile-dictation:1:d' })
    await settleMicrotasks()
    expect(gated.calls).toEqual([
      'activate:orca-mobile-dictation:1:c',
      'activate:orca-mobile-dictation:1:d'
    ])
    gated.settle('activate:orca-mobile-dictation:1:d')
    await expect(second).resolves.toEqual({ active: true })
    gated.settle('activate:orca-mobile-dictation:1:c')
    await expect(first).resolves.toEqual({ active: true })
  })

  it('does not ask the device again for a tag a queued release already gave back', async () => {
    // `dispose` queues behind the tag's own operations, so by the time it runs the release ahead
    // of it may have returned the tag. Deactivating an unheld tag is a native call this module
    // does not make: its failure would read to the page as a lock it could not drop.
    const gated = createGatedDevice()
    const server = createNativeWakelockServer(gated.device)
    const activated = server.serve({ active: true, tag: 'orca-mobile-dictation:1:e' })
    await settleMicrotasks()
    gated.settle('activate:orca-mobile-dictation:1:e')
    await expect(activated).resolves.toEqual({ active: true })
    const released = server.serve({ active: false, tag: 'orca-mobile-dictation:1:e' })
    await settleMicrotasks()
    server.dispose()
    gated.settle('deactivate:orca-mobile-dictation:1:e')
    await expect(released).resolves.toEqual({ active: false })
    await settleMicrotasks()
    expect(gated.calls).toEqual([
      'activate:orca-mobile-dictation:1:e',
      'deactivate:orca-mobile-dictation:1:e'
    ])
  })
})
