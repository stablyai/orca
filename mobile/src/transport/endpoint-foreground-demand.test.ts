import { describe, expect, it } from 'vitest'
import { startEndpointForegroundDemand } from './endpoint-foreground-demand'

function harness(initialState: string) {
  const appListeners = new Set<(state: string) => void>()
  const keepAliveListeners = new Set<() => void>()
  const applied: boolean[] = []
  let keepAlive = false
  const stop = startEndpointForegroundDemand({
    appState: {
      currentState: initialState,
      addEventListener: (_type, listener) => {
        appListeners.add(listener)
        return {
          remove: () => {
            appListeners.delete(listener)
          }
        }
      }
    },
    isKeepAliveActive: () => keepAlive,
    subscribeKeepAlive: (listener) => {
      keepAliveListeners.add(listener)
      return () => {
        keepAliveListeners.delete(listener)
      }
    },
    apply: (foreground) => {
      applied.push(foreground)
    }
  })
  return {
    applied,
    stop,
    appListeners,
    keepAliveListeners,
    setAppState: (state: string) => {
      for (const listener of appListeners) {
        listener(state)
      }
    },
    setKeepAlive: (next: boolean) => {
      keepAlive = next
      for (const listener of keepAliveListeners) {
        listener()
      }
    }
  }
}

describe('startEndpointForegroundDemand', () => {
  it('applies the initial state once', () => {
    expect(harness('active').applied).toEqual([true])
    expect(harness('background').applied).toEqual([false])
  })

  it('follows the app into the background and back', () => {
    const demand = harness('active')
    demand.setAppState('background')
    demand.setAppState('active')
    expect(demand.applied).toEqual([true, false, true])
  })

  it('stays foreground in the background while a keep-alive holds it', () => {
    const demand = harness('active')
    demand.setKeepAlive(true)
    demand.setAppState('background')
    expect(demand.applied).toEqual([true])
    demand.setKeepAlive(false)
    expect(demand.applied).toEqual([true, false])
  })

  it('turns foreground when a keep-alive starts in the background', () => {
    const demand = harness('background')
    demand.setKeepAlive(true)
    expect(demand.applied).toEqual([false, true])
  })

  it('never applies the same value twice in a row', () => {
    const demand = harness('active')
    demand.setAppState('active')
    demand.setKeepAlive(true)
    demand.setAppState('inactive')
    demand.setAppState('background')
    demand.setKeepAlive(true)
    expect(demand.applied).toEqual([true])
  })

  it('unsubscribes from both sources when stopped', () => {
    const demand = harness('active')
    demand.stop()
    expect(demand.appListeners.size).toBe(0)
    expect(demand.keepAliveListeners.size).toBe(0)
  })
})
