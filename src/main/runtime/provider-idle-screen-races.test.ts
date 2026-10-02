import { describe, expect, it, vi } from 'vitest'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import {
  CAPTURED_LINES,
  changeProviderOwner as changeOwner,
  createProviderIdlePane,
  observeIdleWait,
  providerSnapshot,
  PTY_ID,
  SNAPSHOT_SEQUENCE,
  PROVIDER_OWNER_RACES as RACES
} from './provider-idle-screen-test-fixture'
import { deferred } from './orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

describe('provider readiness ownership and sequence fences', () => {
  it.each(RACES)('vetoes %s replacement during acquisition', async (race) => {
    const read = deferred<PtyProviderBufferSnapshot | null>()
    const serializeProviderBuffer = vi.fn(() => read.promise)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(2000)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    changeOwner(pane.runtime, race)
    read.resolve(providerSnapshot())
    await vi.advanceTimersByTimeAsync(6000)
    expect(await wait.settled).toBe('timeout')
    expect(pane.runtime.pendingResources()).toEqual({
      waiters: 0,
      timers: 0,
      visibleReads: 0,
      acquisitions: 0,
      scans: 0
    })
  })

  it.each(RACES)('vetoes %s replacement during parsing', async (race) => {
    const pane = await createProviderIdlePane()
    const parse = deferred<void>()
    const entered = vi.fn(() => parse.promise)
    pane.runtime.beforeParse = entered
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(2000)
    expect(entered).toHaveBeenCalledOnce()
    changeOwner(pane.runtime, race)
    parse.resolve()
    await vi.advanceTimersByTimeAsync(6000)
    expect(await wait.settled).toBe('timeout')
    expect(pane.runtime.pendingResources()).toEqual({
      waiters: 0,
      timers: 0,
      visibleReads: 0,
      acquisitions: 0,
      scans: 0
    })
  })

  it.each(RACES)('vetoes %s replacement immediately before resolution', async (race) => {
    const pane = await createProviderIdlePane()
    const beforeResolve = vi.fn(() => changeOwner(pane.runtime, race))
    let exitCode: number | null = null
    Object.defineProperty(pane.runtime.pty(), 'lastExitCode', {
      configurable: true,
      get: () => {
        if (beforeResolve.mock.calls.length === 0) {
          beforeResolve()
        }
        return exitCode
      },
      set: (value: number | null) => {
        exitCode = value
      }
    })
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(8000)
    expect(beforeResolve).toHaveBeenCalledOnce()
    expect(await wait.settled).toBe('timeout')
  })

  it('vetoes output arriving while the arbiter reads the provider evidence', async () => {
    const pane = await createProviderIdlePane()
    const beforeEvidence = vi.fn(() => {
      pane.runtime.beforeEvidence = null
      changeOwner(pane.runtime, 'output')
    })
    pane.runtime.afterParse = () => {
      pane.runtime.beforeEvidence = beforeEvidence
    }
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(8000)
    expect(beforeEvidence).toHaveBeenCalledOnce()
    expect(await wait.settled).toBe('timeout')
  })

  it('re-reads first-party working evidence after the provider read', async () => {
    const pane = await createProviderIdlePane()
    pane.runtime.afterParse = () => {
      pane.runtime.pty().lastExplicitAgentStatus = { state: 'working', updatedAt: Date.now() }
    }
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await wait.settled).toBe('timeout')
    expect(pane.serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('refuses a fresh main-turn working hook that arrives during the provider read', async () => {
    const rows: AgentStatusIpcPayload[] = []
    const pane = await createProviderIdlePane('pty', {}, { getAgentStatusSnapshot: () => rows })
    pane.runtime.afterParse = () => {
      pane.runtime.pty().foregroundAgent = 'opencode2'
      rows.push({
        paneKey: 'tab-other:11111111-1111-4111-8111-111111111111',
        terminalHandle: pane.handle,
        connectionId: null,
        state: 'working',
        prompt: '',
        agentType: 'opencode2',
        receivedAt: Date.now(),
        stateStartedAt: Date.now()
      })
    }
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await wait.settled).toBe('timeout')
    expect(rows).toHaveLength(1)
    expect(pane.serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it.each(['working', 'permission', 'hook'] as const)(
    'refuses %s evidence that changes while the result is built',
    async (kind) => {
      const rows: AgentStatusIpcPayload[] = []
      const pane = await createProviderIdlePane('pty', {}, { getAgentStatusSnapshot: () => rows })
      let changed = false
      let exitCode: number | null = null
      Object.defineProperty(pane.runtime.pty(), 'lastExitCode', {
        configurable: true,
        get: () => {
          if (!changed) {
            changed = true
            if (kind === 'working') {
              pane.runtime.pty().lastExplicitAgentStatus = {
                state: 'working',
                updatedAt: Date.now()
              }
            } else if (kind === 'permission') {
              pane.runtime.pty().lastAgentStatus = 'permission'
            } else {
              pane.runtime.pty().foregroundAgent = 'opencode2'
              rows.push({
                paneKey: 'tab-other:11111111-1111-4111-8111-111111111111',
                terminalHandle: pane.handle,
                connectionId: null,
                state: 'working',
                prompt: '',
                agentType: 'opencode2',
                receivedAt: Date.now(),
                stateStartedAt: Date.now()
              })
            }
          }
          return exitCode
        },
        set: (value: number | null) => {
          exitCode = value
        }
      })
      const wait = observeIdleWait(pane)
      await vi.advanceTimersByTimeAsync(8000)
      expect(changed).toBe(true)
      expect(await wait.settled).toBe('timeout')
    }
  )

  it('rearms acquisition only after output advances and becomes quiet again', async () => {
    const read = deferred<PtyProviderBufferSnapshot | null>()
    const serializeProviderBuffer = vi.fn(() => read.promise)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    pane.runtime.synchronizePtyOutputSequenceFromProvider(
      PTY_ID,
      {
        value: SNAPSHOT_SEQUENCE,
        generation: 'continued'
      },
      pane.runtime.getPtyOutputSequence(PTY_ID)
    )
    const wait = observeIdleWait(pane, { timeoutMs: 12000 })
    await vi.advanceTimersByTimeAsync(2000)
    pane.runtime.onPtyData(PTY_ID, 'new paint', Date.now())
    read.resolve(providerSnapshot())
    await vi.advanceTimersByTimeAsync(2000)
    expect(wait.outcome()).toBeNull()
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    serializeProviderBuffer.mockImplementation(async () => ({
      ...providerSnapshot(CAPTURED_LINES),
      seq: pane.runtime.getPtyOutputSequence(PTY_ID)
    }))
    await vi.advanceTimersByTimeAsync(2200)
    expect(await wait.settled).toMatchObject({ satisfied: true })
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
  })
})

describe('bounded coalesced provider waits', () => {
  it('cancels one waiter without canceling the shared read needed by another', async () => {
    const read = deferred<PtyProviderBufferSnapshot | null>()
    const serializeProviderBuffer = vi.fn(() => read.promise)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    const abort = new AbortController()
    const first = observeIdleWait(pane, { signal: abort.signal })
    const second = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(2000)
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    abort.abort()
    expect(await first.settled).toBe('request_aborted')
    expect(pane.runtime.pendingResources().timers).toBe(1)
    read.resolve(providerSnapshot())
    await vi.advanceTimersByTimeAsync(200)
    expect(await second.settled).toMatchObject({ satisfied: true })
    expect(pane.runtime.pendingResources()).toEqual({
      waiters: 0,
      timers: 0,
      visibleReads: 0,
      acquisitions: 0,
      scans: 0
    })
  })

  it.each(['timeout', 'link-loss', 'abort'] as const)(
    '%s retires waiters and leaves no late success after the provider returns',
    async (failure) => {
      const read = deferred<PtyProviderBufferSnapshot | null>()
      const serializeProviderBuffer = vi.fn(() => read.promise)
      const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
      const abort = new AbortController()
      const first = observeIdleWait(pane, { signal: abort.signal })
      const second = observeIdleWait(pane, { signal: abort.signal })
      await vi.advanceTimersByTimeAsync(2000)
      if (failure === 'link-loss') {
        read.reject(new Error('provider_connection_lost'))
      } else if (failure === 'abort') {
        abort.abort()
      }
      await vi.advanceTimersByTimeAsync(6000)
      expect(await first.settled).toBe(failure === 'abort' ? 'request_aborted' : 'timeout')
      expect(await second.settled).toBe(first.outcome())
      expect(pane.runtime.pendingResources()).toMatchObject({ waiters: 0, timers: 0 })
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
      read.resolve(providerSnapshot())
      await vi.advanceTimersByTimeAsync(0)
      expect(pane.runtime.pendingResources()).toEqual({
        waiters: 0,
        timers: 0,
        visibleReads: 0,
        acquisitions: 0,
        scans: 0
      })
      expect(first.outcome()).toBe(failure === 'abort' ? 'request_aborted' : 'timeout')
      expect(pane.runtime.retainedState().providerPreferred).toBe(true)
    }
  )
})
