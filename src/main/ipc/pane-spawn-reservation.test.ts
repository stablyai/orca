import { describe, expect, it } from 'vitest'
import {
  adoptPaneSpawn,
  awaitPaneSpawnReservation,
  getPaneSpawnReservation,
  rejectPaneSpawnReservation,
  releasePaneSpawn,
  reservePaneSpawn,
  resolvePaneSpawnReservation
} from './pane-spawn-reservation'

describe('pane spawn reservation retirement', () => {
  it('protects a live waiter when the creator retires after resolution', async () => {
    const reservation = reservePaneSpawn('creator-retires')
    const waiter = awaitPaneSpawnReservation(reservation)
    const creator = resolvePaneSpawnReservation('creator-retires', reservation, {
      id: 'pty-creator-retires',
      spawnDisposition: 'created' as const
    })
    const awaited = await waiter

    expect(releasePaneSpawn(creator.id, creator.spawnRetirementToken!)).toBe(false)
    expect(adoptPaneSpawn(awaited.id, awaited.spawnRetirementToken!)).toBe(true)
  })

  it('protects a live creator when a waiter retires after resolution', async () => {
    const reservation = reservePaneSpawn('waiter-retires')
    const waiter = awaitPaneSpawnReservation(reservation)
    const creator = resolvePaneSpawnReservation('waiter-retires', reservation, {
      id: 'pty-waiter-retires',
      spawnDisposition: 'created' as const
    })
    const awaited = await waiter

    expect(releasePaneSpawn(awaited.id, awaited.spawnRetirementToken!)).toBe(false)
    expect(adoptPaneSpawn(creator.id, creator.spawnRetirementToken!)).toBe(true)
  })

  it('retires only after every participant abandons the created PTY', async () => {
    const reservation = reservePaneSpawn('all-retire')
    const waiter = awaitPaneSpawnReservation(reservation)
    const creator = resolvePaneSpawnReservation('all-retire', reservation, {
      id: 'pty-all-retire',
      spawnDisposition: 'created' as const
    })
    const awaited = await waiter

    expect(releasePaneSpawn(creator.id, creator.spawnRetirementToken!)).toBe(false)
    expect(releasePaneSpawn(awaited.id, awaited.spawnRetirementToken!)).toBe(true)
  })

  it('leaves creator-only retirement unchanged and clears rejected reservations for retry', async () => {
    const creatorOnly = reservePaneSpawn('creator-only')
    const result = resolvePaneSpawnReservation('creator-only', creatorOnly, {
      id: 'pty-creator-only',
      spawnDisposition: 'created' as const
    })
    expect(result.spawnRetirementToken).toBeUndefined()

    const rejected = reservePaneSpawn('retry')
    const rejectedWaiter = awaitPaneSpawnReservation(rejected)
    rejectPaneSpawnReservation('retry', rejected, new Error('spawn failed'))
    await expect(rejectedWaiter).rejects.toThrow('spawn failed')
    expect(getPaneSpawnReservation('retry')).toBeUndefined()
    const retry = reservePaneSpawn('retry')
    expect(retry).not.toBe(rejected)
    rejectPaneSpawnReservation('retry', retry, new Error('test cleanup'))
  })
})
