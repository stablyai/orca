import { describe, expect, it, vi } from 'vitest'
import {
  engageGpuFallback,
  shouldKeepProvisionalGpuFallbackMarker,
  type GpuFallbackEngagementDeps,
  type GpuFallbackEngagementOutcome
} from './gpu-fallback-engagement'

/** Fake disk so tests assert the marker's real state, not just call counts. */
function createDeps(
  overrides: Partial<GpuFallbackEngagementDeps> & { clearSucceeds?: boolean } = {}
) {
  const { clearSucceeds = true, ...depOverrides } = overrides
  const order: string[] = []
  const state = { markerOnDisk: false }
  const deps: GpuFallbackEngagementDeps = {
    persistMarker: vi.fn(() => {
      order.push('persist')
      state.markerOnDisk = true
    }),
    clearMarker: vi.fn(() => {
      order.push('clear')
      if (!clearSucceeds) {
        return false
      }
      state.markerOnDisk = false
      return true
    }),
    prompt: vi.fn(async () => {
      order.push('prompt')
      return 'restart' as const
    }),
    isQuitting: () => false,
    onMarkerPersistFailed: vi.fn(),
    onMarkerClearFailed: vi.fn(),
    onPromptFailed: vi.fn(),
    onRestartDeferred: vi.fn(),
    ...depOverrides
  }
  return { deps, order, state }
}

describe('engageGpuFallback', () => {
  it('persists the marker before showing the prompt', async () => {
    const { deps, order } = createDeps()

    await expect(engageGpuFallback(deps)).resolves.toBe('restart')

    // The whole point: Chromium can hard-kill the process while the modal is up.
    expect(order).toEqual(['persist', 'prompt'])
  })

  it('persists the marker synchronously, before the first await yields', async () => {
    const { deps, state } = createDeps()

    // Deliberately not awaited: any await added ahead of the write would defer it
    // past Chromium's GPU CHECK, which is the exact bug this module exists to fix.
    const pending = engageGpuFallback(deps)
    expect(deps.persistMarker).toHaveBeenCalledOnce()
    expect(state.markerOnDisk).toBe(true)

    await pending
  })

  it('has the marker on disk while the prompt is still unanswered', async () => {
    const { deps, state } = createDeps({ prompt: vi.fn(() => new Promise<never>(() => {})) })

    const outcome = await Promise.race([
      engageGpuFallback(deps),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 10))
    ])

    expect(outcome).toBe('still-pending')
    // A kill landing here must find a marker the next launch can read.
    expect(state.markerOnDisk).toBe(true)
  })

  it('clears the marker after the user chooses to keep running', async () => {
    const { deps, order, state } = createDeps({
      prompt: vi.fn(async () => {
        order.push('prompt')
        return 'continue' as const
      })
    })

    await expect(engageGpuFallback(deps)).resolves.toBe('deferred')

    expect(order).toEqual(['persist', 'prompt', 'clear'])
    expect(state.markerOnDisk).toBe(false)
    expect(deps.onRestartDeferred).toHaveBeenCalledOnce()
    expect(deps.onMarkerClearFailed).not.toHaveBeenCalled()
  })

  it('honors "keep running" even when a quit races the answer', async () => {
    // Why: a tray/OS quit resolves the parented dialog; discarding the opt-out
    // there would strand the user in safe-graphics mode they declined.
    const { deps, state } = createDeps({
      prompt: vi.fn(async () => 'continue' as const),
      isQuitting: () => true
    })

    await expect(engageGpuFallback(deps)).resolves.toBe('deferred')

    expect(state.markerOnDisk).toBe(false)
  })

  it('keeps the caller armed when the decline could not be written through', async () => {
    const { deps, state } = createDeps({
      prompt: vi.fn(async () => 'continue' as const),
      clearSucceeds: false
    })

    // Why a distinct outcome: a plain 'deferred' lets the caller stand down and
    // the declined marker then latches the user in on the next launch.
    await expect(engageGpuFallback(deps)).resolves.toBe('deferred-uncleared')

    expect(state.markerOnDisk).toBe(true)
    expect(deps.onMarkerClearFailed).toHaveBeenCalledOnce()
  })

  it('rejects an async persistMarker instead of prompting behind it', async () => {
    // Why: `() => void` structurally accepts an async function, whose write
    // would land after the kill window and whose rejection would escape.
    const { deps } = createDeps({ persistMarker: vi.fn(async () => {}) })

    await expect(engageGpuFallback(deps)).resolves.toBe('marker-failed')

    expect(deps.prompt).not.toHaveBeenCalled()
    expect(deps.onMarkerPersistFailed).toHaveBeenCalledWith(expect.any(TypeError))
  })

  it('keeps the marker when the prompt itself fails', async () => {
    const error = new Error('no display')
    const { deps, state } = createDeps({
      prompt: vi.fn(async () => {
        throw error
      })
    })

    await expect(engageGpuFallback(deps)).resolves.toBe('latched')

    expect(deps.onPromptFailed).toHaveBeenCalledWith(error)
    expect(state.markerOnDisk).toBe(true)
    expect(deps.clearMarker).not.toHaveBeenCalled()
  })

  it('keeps a consented restart when a quit is already in flight', async () => {
    const { deps, state } = createDeps({ isQuitting: () => true })

    // Why not 'latched': the caller must not treat consented state as provisional
    // and delete the marker on the way out.
    await expect(engageGpuFallback(deps)).resolves.toBe('confirmed-quitting')

    expect(state.markerOnDisk).toBe(true)
    expect(deps.clearMarker).not.toHaveBeenCalled()
  })

  it('keeps the shutdown retry armed only for unsettled outcomes', () => {
    // Why exhaustive: the caller drops its retry on a false, so a wrong entry here
    // either strands the user in declined safe graphics or deletes consented state.
    const expected: Record<GpuFallbackEngagementOutcome, boolean> = {
      restart: false,
      'confirmed-quitting': false,
      deferred: false,
      'deferred-uncleared': true,
      latched: true,
      'marker-failed': false
    }
    for (const [outcome, keep] of Object.entries(expected)) {
      expect([outcome, shouldKeepProvisionalGpuFallbackMarker(outcome as never)]).toEqual([
        outcome,
        keep
      ])
    }
  })

  it('does not prompt when the marker cannot be persisted', async () => {
    const error = new Error('EACCES')
    const { deps } = createDeps({
      persistMarker: vi.fn(() => {
        throw error
      })
    })

    await expect(engageGpuFallback(deps)).resolves.toBe('marker-failed')

    // Why: a relaunch would come back on the same broken GPU, so offering one lies.
    expect(deps.prompt).not.toHaveBeenCalled()
    expect(deps.onMarkerPersistFailed).toHaveBeenCalledWith(error)
  })
})
