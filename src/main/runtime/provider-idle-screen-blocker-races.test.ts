import { describe, expect, it, vi } from 'vitest'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import { deferred } from './orca-runtime-test-fixtures.spec'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import {
  changeProviderOwner,
  createProviderIdlePane,
  observeIdleWait,
  PROVIDER_OWNER_RACES,
  providerSnapshot
} from './provider-idle-screen-test-fixture'

const TRUST_SCREEN = 'Do you trust the files in this folder?'

function recordedTrustSnapshot() {
  return {
    ...providerSnapshot(),
    data: readRuntimeFixture('codex-0-158-0-trustprompt'),
    cols: 120,
    rows: 40
  }
}

describe('rendered blocker ownership fences', () => {
  it.each(PROVIDER_OWNER_RACES)('vetoes %s changes during the rendered read', async (race) => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => null
    })
    await pane.runtime.model().emulator.write(TRUST_SCREEN)
    const read = deferred<void>()
    const entered = vi.fn(() => read.promise)
    pane.runtime.beforeVisibleRead = entered
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(entered).toHaveBeenCalledOnce()
    changeProviderOwner(pane.runtime, race)
    read.resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(await wait.settled).toBe('timeout')
    expect(pane.runtime.pendingResources()).toMatchObject({ waiters: 0, timers: 0 })
  })

  it.each(PROVIDER_OWNER_RACES)(
    'vetoes %s changes while building a rendered result',
    async (race) => {
      const pane = await createProviderIdlePane('pty', {
        serializeProviderBuffer: async () => null
      })
      await pane.runtime.model().emulator.write(TRUST_SCREEN)
      const change = vi.fn(() => changeProviderOwner(pane.runtime, race))
      let exitCode: number | null = null
      Object.defineProperty(pane.runtime.pty(), 'lastExitCode', {
        configurable: true,
        get: () => {
          if (change.mock.calls.length === 0) {
            change()
          }
          return exitCode
        },
        set: (value: number | null) => {
          exitCode = value
        }
      })
      const wait = observeIdleWait(pane, { timeoutMs: 2500 })
      await vi.advanceTimersByTimeAsync(2500)
      expect(change).toHaveBeenCalledOnce()
      expect(await wait.settled).toBe('timeout')
    }
  )

  it('rechecks working evidence after the rendered read', async () => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => null
    })
    await pane.runtime.model().emulator.write(TRUST_SCREEN)
    pane.runtime.beforeVisibleRead = () => {
      pane.runtime.pty().lastExplicitAgentStatus = { state: 'working', updatedAt: Date.now() }
    }
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await wait.settled).toBe('timeout')
  })

  it('leaves no late blocked result after aborting a rendered read', async () => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => null
    })
    await pane.runtime.model().emulator.write(TRUST_SCREEN)
    const read = deferred<void>()
    pane.runtime.beforeVisibleRead = () => read.promise
    const abort = new AbortController()
    const wait = observeIdleWait(pane, { signal: abort.signal })
    await vi.advanceTimersByTimeAsync(2000)
    abort.abort()
    expect(await wait.settled).toBe('request_aborted')
    read.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.outcome()).toBe('request_aborted')
    expect(pane.runtime.pendingResources()).toMatchObject({ waiters: 0, timers: 0 })
  })

  it('does not settle a leaf rebound during the rendered read', async () => {
    const pane = await createProviderIdlePane('leaf', {
      serializeProviderBuffer: async () => null
    })
    await pane.runtime.model().emulator.write(TRUST_SCREEN)
    pane.runtime.beforeVisibleRead = () => pane.runtime.rebindLeaf()
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await wait.settled).toBe('timeout')
  })
})

describe('provider blocker ownership fences', () => {
  it.each(PROVIDER_OWNER_RACES)(
    'vetoes %s changes during acquisition of a dialog',
    async (race) => {
      const read = deferred<PtyProviderBufferSnapshot | null>()
      const pane = await createProviderIdlePane('pty', {
        serializeProviderBuffer: () => read.promise
      })
      pane.runtime.removeModel()
      const wait = observeIdleWait(pane, { timeoutMs: 2500 })
      await vi.advanceTimersByTimeAsync(2000)
      changeProviderOwner(pane.runtime, race)
      read.resolve(recordedTrustSnapshot())
      await vi.advanceTimersByTimeAsync(500)
      expect(await wait.settled).toBe('timeout')
    }
  )

  it.each(PROVIDER_OWNER_RACES)('vetoes %s changes during parsing of a dialog', async (race) => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => recordedTrustSnapshot()
    })
    pane.runtime.removeModel()
    const parse = deferred<void>()
    const entered = vi.fn(() => parse.promise)
    pane.runtime.beforeParse = entered
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(entered).toHaveBeenCalledOnce()
    changeProviderOwner(pane.runtime, race)
    parse.resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(await wait.settled).toBe('timeout')
  })

  it.each(PROVIDER_OWNER_RACES)(
    'vetoes %s changes while building a provider result',
    async (race) => {
      const pane = await createProviderIdlePane('pty', {
        serializeProviderBuffer: async () => recordedTrustSnapshot()
      })
      pane.runtime.removeModel()
      const change = vi.fn(() => changeProviderOwner(pane.runtime, race))
      let exitCode: number | null = null
      Object.defineProperty(pane.runtime.pty(), 'lastExitCode', {
        configurable: true,
        get: () => {
          if (change.mock.calls.length === 0) {
            change()
          }
          return exitCode
        },
        set: (value: number | null) => {
          exitCode = value
        }
      })
      const wait = observeIdleWait(pane, { timeoutMs: 2500 })
      await vi.advanceTimersByTimeAsync(2500)
      expect(change).toHaveBeenCalledOnce()
      expect(await wait.settled).toBe('timeout')
    }
  )

  it('rechecks first-party working evidence after parsing the dialog', async () => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => recordedTrustSnapshot()
    })
    pane.runtime.afterParse = () => {
      pane.runtime.pty().lastExplicitAgentStatus = { state: 'working', updatedAt: Date.now() }
    }
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await wait.settled).toBe('timeout')
  })

  it('coalesces two dialog waits and aborts only the requested waiter', async () => {
    const read = deferred<PtyProviderBufferSnapshot | null>()
    const serializeProviderBuffer = vi.fn(() => read.promise)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    pane.runtime.removeModel()
    const abort = new AbortController()
    const first = observeIdleWait(pane, { signal: abort.signal })
    const second = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(2000)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    abort.abort()
    expect(await first.settled).toBe('request_aborted')
    read.resolve(recordedTrustSnapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(await second.settled).toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
    expect(pane.runtime.pendingResources()).toEqual({
      waiters: 0,
      timers: 0,
      visibleReads: 0,
      acquisitions: 0,
      scans: 0
    })
  })

  it('does not settle a leaf rebound during provider parsing', async () => {
    const pane = await createProviderIdlePane('leaf', {
      serializeProviderBuffer: async () => recordedTrustSnapshot()
    })
    pane.runtime.removeModel()
    pane.runtime.afterParse = () => pane.runtime.rebindLeaf()
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await wait.settled).toBe('timeout')
  })
})

it.each(['rendered', 'provider'] as const)(
  'vetoes output advancing during %s blocker arbitration',
  async (source) => {
    const pane = await createProviderIdlePane('pty', {
      serializeProviderBuffer: async () => (source === 'provider' ? recordedTrustSnapshot() : null)
    })
    if (source === 'rendered') {
      await pane.runtime.model().emulator.write(TRUST_SCREEN)
    }
    const change = vi.fn(() => {
      pane.runtime.beforeEvidence = null
      changeProviderOwner(pane.runtime, 'output')
    })
    const beforeEvidence = () => {
      pane.runtime.beforeEvidence = change
    }
    if (source === 'provider') {
      pane.runtime.afterParse = beforeEvidence
    } else {
      pane.runtime.beforeVisibleRead = beforeEvidence
    }
    const wait = observeIdleWait(pane, { timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(change).toHaveBeenCalledOnce()
    expect(await wait.settled).toBe('timeout')
  }
)
