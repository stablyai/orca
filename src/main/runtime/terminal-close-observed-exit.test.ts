import { describe, expect, it } from 'vitest'
import {
  runObservedExitControl,
  runObservedExitSocketScenario
} from './terminal-close-observed-exit-test-fixture'

describe('closing a terminal after observing its physical exit', () => {
  it('preserves the physical cause when an unrelated daemon prevents aggregate verification', async () => {
    const result = await runObservedExitSocketScenario('physical-exit-observed')
    expect(result.close).toEqual({ ptyKilled: true, ptyStopVerdict: null })
    expect(result.fallbackKills).toBe(0)
    expect(result.targetInventoryCount).toBe(0)
    expect(result.targetProbe).toBe(false)
    expect(result.routerProbe).toBeNull()
    expect(result.settled).toMatchObject({
      connected: false,
      exitCause: { kind: 'operator_close' },
      headlessModelRetained: false,
      titleTrackerRetained: false,
      liveness: 'exited',
      rendererExitCount: 1,
      providerExitCount: 1,
      exitListenerCalls: 1
    })
  })

  it('keeps the healthy aggregate verification and delayed physical exit behavior', async () => {
    const result = await runObservedExitSocketScenario('healthy')
    expect(result.close.ptyKilled).toBe(true)
    expect(result.fallbackKills).toBe(0)
    expect(result.routerProbe).toBe(false)
    expect(result.settled.exitCause).toEqual({ kind: 'operator_close' })
    expect(result.settled.rendererExitCount).toBe(1)
    expect(result.settled.exitListenerCalls).toBe(1)
  })

  it('does not treat target absence as an earned exit before the stream delivers it', async () => {
    const result = await runObservedExitSocketScenario('unrelated-endpoint-gone')
    expect(result.close).toEqual({ ptyKilled: false, ptyStopVerdict: 'unverifiable' })
    expect(result.fallbackKills).toBe(1)
    expect(result.targetProbe).toBe(false)
    expect(result.routerProbe).toBeNull()
    expect(result.beforeStreamResume.providerExitCount).toBe(0)
  })

  it('uses a stamped exit for the incarnation that was actually being closed', async () => {
    const result = await runObservedExitControl('same-incarnation')
    expect(result.stopped).toBe(true)
    expect(result.fallbackKills).toBe(0)
    expect(result.verdict?.status).toBe('exited')
  })

  it.each(['replacement', 'unverified', 'legacy-unstamped', 'throw-after-exit'] as const)(
    'does not reuse an exit for %s',
    async (control) => {
      const result = await runObservedExitControl(control)
      expect(result.stopped).toBe(false)
      expect(result.fallbackKills).toBe(1)
    }
  )
})
