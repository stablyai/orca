import { createAdapter } from './daemon-pty-router-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from '../daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'
import type { PtyProcessInfo } from '../../../../providers/pty/process-info'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

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
})
