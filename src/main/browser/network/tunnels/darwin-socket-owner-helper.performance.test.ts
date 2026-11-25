import { setSpawnObserver } from '@orca/process-host/spawn-observer'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isOwnDarwinConnection, retainDarwinSocketOwnerHelper } from './darwin-socket-owner-helper'
import { useVouchingSocketOwnerHelper } from './darwin-socket-owner-helper.test-fixture'

// STA-17768: macOS paired forwards and the browser SOCKS listener check every connection's owner
// through one helper process held while a listener is open, not one spawn per connection.
describe.skipIf(process.platform === 'win32')('macOS socket owner helper spawns', () => {
  let restore = async (): Promise<void> => {}
  let spawns = 0
  beforeAll(async () => {
    const helper = await useVouchingSocketOwnerHelper()
    restore = helper.restore
    setSpawnObserver((command) => {
      if (command === helper.path) {
        spawns++
      }
    })
  })
  afterEach(() => {
    spawns = 0
  })
  afterAll(async () => {
    setSpawnObserver(null)
    await restore()
  })

  it.each([100, 1_000])('spawns one helper for %i connections across two listeners', async (n) => {
    const releaseForward = retainDarwinSocketOwnerHelper()
    const releaseSocks = retainDarwinSocketOwnerHelper()
    const answers = await Promise.all(
      Array.from({ length: n }, (_, index) =>
        isOwnDarwinConnection(
          { host: '127.0.0.1', port: 20_000 + index },
          { host: '127.0.0.1', port: 5173 }
        )
      )
    )
    expect(answers.every(Boolean)).toBe(true)
    releaseForward()
    expect(spawns).toBe(1)
    releaseSocks()
    // The last listener closed: nothing is kept running, and the next listener starts afresh.
    await expect(
      isOwnDarwinConnection({ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 })
    ).rejects.toThrow()
    const release = retainDarwinSocketOwnerHelper()
    await isOwnDarwinConnection({ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 })
    release()
    expect(spawns).toBe(2)
  })
  it('refuses lookups past the queue cap without failing the helper for live listeners', async () => {
    const release = retainDarwinSocketOwnerHelper()
    const lookup = (port: number) =>
      isOwnDarwinConnection({ host: '127.0.0.1', port }, { host: '127.0.0.1', port: 5173 }).then(
        () => 'answered',
        () => 'refused'
      )
    const outcomes = await Promise.all(
      Array.from({ length: 2_000 }, (_, index) => lookup(index + 1))
    )
    expect(outcomes.filter((outcome) => outcome === 'answered')).toHaveLength(1_024)
    // The flood is shed, not counted as a stuck helper: the next connection is still checked.
    await expect(lookup(1)).resolves.toBe('answered')
    release()
    expect(spawns).toBe(1)
  })
})
