// A worker whose shell ended while Orca was closed leaves no route behind: nothing in this
// process claims its id any more. The incarnation-scoped question is exactly the one that has to
// survive that, so both daemon-fronting providers must carry it (and its `expectedIncarnationId`)
// to a daemon instead of answering `terminal_gone` from their own bookkeeping.
import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider } from '../providers/types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

const INCARNATION = 'c0ffee00-0000-4000-8000-000000000001'

const EXITED: PtyProcessInspection = {
  foregroundProcess: null,
  hasChildProcesses: false,
  foregroundProcessEvidence: {
    authorityGeneration: 'gen-1',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId: 'pty-away',
    ptyIncarnationId: INCARNATION,
    verdict: 'exited',
    reason: 'pty_exit_0'
  }
}

function createAdapter(sessions: string[] = []): DaemonPtyAdapter {
  return {
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    inspectProcess: vi.fn(async () => EXITED),
    consumeExitReceipt: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: 'daemon' }))),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {}),
    onBackgroundStreamEvent: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

function createFallbackProvider(): IPtyProvider {
  return {
    hasPty: vi.fn(() => false),
    inspectProcess: vi.fn(async () => EXITED),
    listProcesses: vi.fn(async () => []),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {}),
    onBackgroundStreamEvent: vi.fn(() => () => {})
  } as unknown as IPtyProvider
}

describe('DaemonPtyRouter incarnation-scoped inspection', () => {
  it('routes receipt consumption like inspection without retiring its route', async () => {
    const current = createAdapter()
    const legacy = createAdapter(['pty-live'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.consumeExitReceipt('pty-away', INCARNATION)
    expect(current.consumeExitReceipt).toHaveBeenCalledWith('pty-away', INCARNATION)
    await router.consumeExitReceipt('pty-live', INCARNATION)
    expect(legacy.consumeExitReceipt).toHaveBeenCalledWith('pty-live', INCARNATION)
    await router.inspectProcess('pty-live', { expectedIncarnationId: INCARNATION })
    expect(legacy.inspectProcess).toHaveBeenCalled()
  })
  it('asks the current daemon about an unclaimed id when the caller names an incarnation', async () => {
    const current = createAdapter()
    const router = new DaemonPtyRouter({ current, legacy: [createAdapter()] })

    await expect(
      router.inspectProcess('pty-away', { expectedIncarnationId: INCARNATION })
    ).resolves.toEqual(EXITED)
    expect(current.inspectProcess).toHaveBeenCalledWith('pty-away', {
      expectedIncarnationId: INCARNATION
    })
  })

  it('forwards the incarnation to the daemon that still claims the id', async () => {
    const legacy = createAdapter(['pty-live'])
    const router = new DaemonPtyRouter({ current: createAdapter(), legacy: [legacy] })

    await router.inspectProcess('pty-live', { expectedIncarnationId: INCARNATION })

    expect(legacy.inspectProcess).toHaveBeenCalledWith('pty-live', {
      expectedIncarnationId: INCARNATION
    })
  })
})

describe('DegradedDaemonPtyProvider incarnation-scoped inspection', () => {
  it('consumes unclaimed daemon evidence without using fallback shutdown', async () => {
    const current = createAdapter()
    const fallback = createFallbackProvider()
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await provider.consumeExitReceipt('pty-away', INCARNATION)
    expect(current.consumeExitReceipt).toHaveBeenCalledWith('pty-away', INCARNATION)
  })
  it('asks the current daemon about an unclaimed id when the caller names an incarnation', async () => {
    const current = createAdapter()
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback: createFallbackProvider()
    })

    await expect(
      provider.inspectProcess('pty-away', { expectedIncarnationId: INCARNATION })
    ).resolves.toEqual(EXITED)
    expect(current.inspectProcess).toHaveBeenCalledWith('pty-away', {
      expectedIncarnationId: INCARNATION
    })
  })

  it('forwards inspection options to the provider that owns the session', async () => {
    const current = createAdapter(['pty-live'])
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback: createFallbackProvider()
    })
    await provider.discoverDaemonSessions()

    await provider.inspectProcess('pty-live', {
      expectedIncarnationId: INCARNATION,
      steadyState: true
    })

    expect(current.inspectProcess).toHaveBeenCalledWith('pty-live', {
      expectedIncarnationId: INCARNATION,
      steadyState: true
    })
  })
})
