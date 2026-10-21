import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_SIGKILL_GRACE_MS,
  reapMacOSProviderProcess
} from './macos-native-provider-process-reaping'

describe('macOS provider reaping resource bounds', () => {
  const providers: ChildProcess[] = []

  afterEach(() => {
    for (const provider of providers.splice(0)) {
      provider.emit('exit', 0, null)
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['exit', 'escalation'] as const)(
    'shares one exit hook across 200 helpers and releases it on %s',
    (mode) => {
      vi.useFakeTimers()
      const baseline = process.listenerCount('exit')
      for (let index = 0; index < 200; index++) {
        const provider = new ChildProcess()
        vi.spyOn(provider, 'kill').mockReturnValue(true)
        providers.push(provider)
        reapMacOSProviderProcess(provider)
        reapMacOSProviderProcess(provider)
        expect(provider.kill).toHaveBeenCalledTimes(1)
      }
      expect(process.listenerCount('exit')).toBe(baseline + 1)
      if (mode === 'exit') {
        for (const provider of providers) {
          provider.emit('exit', 0, null)
        }
      }
      vi.advanceTimersByTime(PROVIDER_SIGKILL_GRACE_MS)

      for (const provider of providers) {
        expect(provider.kill).toHaveBeenCalledTimes(mode === 'exit' ? 1 : 2)
        expect(provider.listenerCount('exit')).toBe(0)
      }
      expect(vi.getTimerCount()).toBe(0)
      expect(process.listenerCount('exit')).toBe(baseline)
    }
  )
})
