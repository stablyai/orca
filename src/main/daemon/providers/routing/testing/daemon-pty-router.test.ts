import { createAdapter } from './daemon-pty-router-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from '../daemon-pty-router'

// Why: drain retirement telemetry is real-module noise here; the router itself never emits it.
vi.mock('../../observability/daemon-lifecycle-event', () => ({ trackDaemonRetired: vi.fn() }))
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'
import type { PtyProcessInfo } from '../../../../providers/pty-provider-contract'
import {
  HISTORY_SEED_TRANSFER_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from '../../../protocol/daemon-protocol-version'

describe('DaemonPtyRouter', () => {
  describe('idle retirement', () => {
    it('retires every empty daemon generation and fences subsequent spawns', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({ state: 'retiring' })
      expect(current.requestIdleRetirement).toHaveBeenCalledOnce()
      expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
      await expect(router.spawn({ sessionId: 'late', cols: 80, rows: 24 })).rejects.toThrow(
        'Terminal daemon is decommissioning'
      )
    })

    it('reports live inventory before retiring any generation and reopens admission', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', ['legacy-live'], undefined, PROTOCOL_VERSION)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(router.requestIdleRetirement()).resolves.toEqual({
        state: 'busy',
        liveSessions: 1,
        admissionReopened: true
      })
      expect(current.requestIdleRetirement).not.toHaveBeenCalled()
      expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
      await expect(
        router.spawn({ sessionId: 'after-refusal', cols: 80, rows: 24 })
      ).resolves.toEqual({
        id: 'after-refusal'
      })
    })

    it('does not certify reopened admission when another generation retired beside live sessions', async () => {
      const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
      const legacy = createAdapter('legacy', [], undefined, PROTOCOL_VERSION)
      vi.mocked(legacy.requestIdleRetirement).mockResolvedValueOnce({
        state: 'busy',
        liveSessions: 1,
        admissionReopened: true
      })
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      await expect(router.requestIdleRetirement()).resolves.toEqual({
        state: 'busy',
        liveSessions: 1
      })
      await expect(
        router.spawn({ sessionId: 'unsafe-partial', cols: 80, rows: 24 })
      ).rejects.toThrow('Terminal daemon is decommissioning')
    })
  })

  it.each([false, true])(
    'keeps newer spawn authority when an older listing completes (duplicate ids: %s)',
    async (duplicateIds) => {
      const current = createAdapter('current')
      const legacy = createAdapter('legacy')
      current.supportsFencedTermination = () => true
      current.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
      legacy.supportsFencedTermination = () => false
      legacy.killFenced = vi.fn(async () => ({
        outcome: 'refused' as const,
        reason: 'unsupported' as const
      }))
      vi.mocked(current.spawn).mockResolvedValue({ id: 'raced', incarnationId: 'new' })
      vi.mocked(current.listProcesses).mockResolvedValue(
        duplicateIds ? [{ id: 'raced', incarnationId: 'old-current', cwd: '', title: '' }] : []
      )
      const { promise: oldInventory, resolve: release } = Promise.withResolvers<PtyProcessInfo[]>()
      vi.mocked(legacy.listProcesses).mockReturnValue(oldInventory)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      const oldListing = router.listProcesses()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
      await router.spawn({ sessionId: 'raced', isNewSession: true, cols: 80, rows: 24 })
      release([{ id: 'raced', incarnationId: 'old-legacy', cwd: '', title: '' }])
      await expect(oldListing).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      const request = {
        id: 'raced',
        expectedIncarnationId: 'new',
        requireNoAgentOwner: true,
        requireUnattached: true
      }

      expect(router.supportsFencedTermination('raced')).toBe(true)
      await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
      expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
      expect(legacy.killFenced).not.toHaveBeenCalled()
      expect(current.listProcesses).toHaveBeenCalledOnce()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
    }
  )

  it('does not let an older refresh overwrite a newer discovery route', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    current.supportsFencedTermination = () => true
    current.killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    legacy.supportsFencedTermination = () => false
    const { promise: staleCurrent, resolve: releaseCurrent } =
      Promise.withResolvers<PtyProcessInfo[]>()
    const { promise: staleLegacy, resolve: releaseLegacy } =
      Promise.withResolvers<PtyProcessInfo[]>()
    vi.mocked(current.listProcesses)
      .mockReturnValueOnce(staleCurrent)
      .mockResolvedValueOnce([{ id: 'discovered', incarnationId: 'new', cwd: '', title: '' }])
    vi.mocked(legacy.listProcesses).mockReturnValueOnce(staleLegacy).mockResolvedValueOnce([])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    const staleRefresh = router.listProcesses()
    await router.discoverLegacySessions()
    releaseCurrent([])
    releaseLegacy([{ id: 'discovered', incarnationId: 'old', cwd: '', title: '' }])
    await expect(staleRefresh).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    const request = {
      id: 'discovered',
      expectedIncarnationId: 'new',
      requireNoAgentOwner: true,
      requireUnattached: true
    }

    expect(router.supportsFencedTermination('discovered')).toBe(true)
    await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
    expect(current.killFenced).toHaveBeenCalledExactlyOnceWith(request)
    expect(current.listProcesses).toHaveBeenCalledTimes(2)
    expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('keeps consulting a legacy daemon whose inventory listing failed', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('wedged'))
    vi.mocked(legacy.probePtyLiveness).mockResolvedValue(null)
    // Why: a wedged inventory cannot prove the generation drained; only the daemon's census can.
    vi.mocked(legacy.requestIdleRetirement).mockResolvedValue({
      state: 'busy',
      liveSessions: 1,
      admissionReopened: true
    })
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    // Without an inventory nothing proves the legacy daemon doesn't own this id.
    await expect(router.probePtyLiveness('unknown-session')).resolves.toBeNull()
    expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
    expect(legacy.probePtyLiveness).not.toHaveBeenCalled()
  })

  it('keeps the legacy route when checkpointed shutdown fails', async () => {
    const current = createAdapter('current', [], undefined, HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const legacy = createAdapter(
      'legacy',
      ['legacy-session'],
      undefined,
      HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1
    )
    vi.mocked(legacy.shutdown).mockRejectedValueOnce(new Error('checkpoint failed'))
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    await expect(router.shutdown('legacy-session', { keepHistory: true })).rejects.toThrow(
      'checkpoint failed'
    )
    await router.spawn({ sessionId: 'legacy-session', cols: 80, rows: 24 })

    expect(legacy.spawn).toHaveBeenCalled()
    expect(legacy.ackColdRestore).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
  })
})

// #9138: a legacy generation whose sessions all exited must not outlive the drain —
// the app's own legacy event connection blocks the daemon-side last-disconnect
// retirement, so the router has to ask once the exits settle.
describe('DaemonPtyRouter legacy drain retirement', () => {
  const DRAIN_DEBOUNCE_MS = 5_000

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retires and detaches a drained legacy adapter once its exits settle', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['legacy-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()
    expect(router.getLegacyAdapters()).toContain(legacy)

    await router.shutdown('legacy-session', { immediate: true })
    legacy.emitExit('legacy-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS)

    expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
    expect(router.getLegacyAdapters()).not.toContain(legacy)
    expect(legacy.disconnectOnly).toHaveBeenCalled()
  })

  it('keeps a legacy adapter that still routes a live session', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy', ['live-session', 'exiting-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    legacy.emitExit('exiting-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS * 2)

    expect(legacy.requestIdleRetirement).not.toHaveBeenCalled()
    expect(router.getLegacyAdapters()).toContain(legacy)
  })

  it('never drains the current generation', async () => {
    const current = createAdapter('current', ['current-session'])
    new DaemonPtyRouter({ current, legacy: [] })

    current.emitExit('current-session', 0)
    await vi.advanceTimersByTimeAsync(DRAIN_DEBOUNCE_MS * 2)

    expect(current.requestIdleRetirement).not.toHaveBeenCalled()
  })

  it('sweeps generations that drained while no app was running at discovery time', async () => {
    const current = createAdapter('current')
    const legacy = createAdapter('legacy')
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })

    await router.discoverLegacySessions()
    // Why zero: the sweep is fire-and-forget; flush its microtasks without waiting the debounce.
    await vi.advanceTimersByTimeAsync(0)

    expect(legacy.requestIdleRetirement).toHaveBeenCalledOnce()
    expect(router.getLegacyAdapters()).not.toContain(legacy)
  })
})
