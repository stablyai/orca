import { describe, expect, it } from 'vitest'
import { DegradedDaemonFreshSpawnRouter } from './degraded-daemon-fresh-spawn-routing'
import { createPtyProviderTestDouble } from '../providers/pty-provider-test-double'

describe('degraded fresh-spawn transitions', () => {
  function setup(probe: () => Promise<boolean>) {
    const current = createPtyProviderTestDouble('daemon')
    const fallback = createPtyProviderTestDouble('local')
    return {
      current,
      fallback,
      router: new DegradedDaemonFreshSpawnRouter(current, fallback, new Map(), probe)
    }
  }

  it('can degrade again after recovery', async () => {
    const { router, current, fallback } = setup(async () => true)
    expect(await router.recover()).toBe(true)
    await router.spawn({ cols: 80, rows: 24 })
    router.degrade()
    await router.spawn({ cols: 80, rows: 24 })
    expect(current.spawn).toHaveBeenCalledOnce()
    expect(fallback.spawn).toHaveBeenCalledOnce()
  })

  it('does not let an in-flight healthy probe undo a newer denial', async () => {
    let resolve!: (healthy: boolean) => void
    const { router } = setup(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const recovery = router.recover()
    router.degrade()
    resolve(true)
    expect(await recovery).toBe(false)
    expect(router.routesToFallback).toBe(true)
  })
})
