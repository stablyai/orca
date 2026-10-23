import { describe, expect, it, vi } from 'vitest'
import { startLateExitHarness } from './daemon-late-exit-test-fixture'
import { ptyIncarnationById } from './provider/ownership-state'

const request = (id: string, expectedIncarnationId: string) => ({
  id,
  expectedIncarnationId,
  requireNoAgentOwner: false,
  requireUnattached: false
})

describe('checked renderer stop route', () => {
  it('refuses missing identity without falling through to the unfenced stop', async () => {
    const harness = await startLateExitHarness()
    try {
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced({ id: harness.id })).resolves.toEqual({
        outcome: 'refused',
        reason: 'unsupported'
      })
      expect(harness.subprocess.forceKill).not.toHaveBeenCalled()
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
      expect(harness.runtime.captureState().connected).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves replacement ownership and runtime status untouched on refusal', async () => {
    const harness = await startLateExitHarness()
    try {
      const before = harness.runtime.captureState()
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced(request(harness.id, 'old-incarnation'))).resolves.toEqual({
        outcome: 'refused',
        reason: 'replaced'
      })
      expect(harness.runtime.captureState()).toEqual(before)
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses old providers at dispatch, and retains ownership after a lost kill response', async () => {
    const harness = await startLateExitHarness()
    try {
      const supports = vi.spyOn(harness.adapter, 'supportsFencedTermination').mockReturnValue(false)
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
      supports.mockRestore()
      vi.spyOn(harness.adapter, 'killFenced').mockRejectedValue(new Error('response lost'))
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
      expect(markStop).not.toHaveBeenCalled()
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('preserves operator-close provenance when the physical exit beats the control response', async () => {
    const harness = await startLateExitHarness()
    try {
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      await harness.waitForExit()
      expect(harness.runtime.captureState().exitCause).toEqual({ kind: 'operator_close' })
    } finally {
      await harness.dispose()
    }
  })

  it('synthesizes an exit only for the proven incarnation when its control response beats the stream', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      expect(harness.runtime.captureState().connected).toBe(false)
      expect(harness.rendererExits).toEqual([
        { id: harness.id, code: -1, incarnationId: harness.result.incarnationId }
      ])
      harness.resumeStream()
      await harness.waitForExit()
      expect(harness.rendererExits).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
