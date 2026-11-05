import { describe, expect, it, vi } from 'vitest'
import {
  engageGpuFallbackAfterCrashBurst,
  type GpuFallbackEngagement,
  type GpuFallbackEngagementHandlers
} from './gpu-fallback-engagement'
import type { GpuFallbackRestartDecision } from './gpu-fallback-restart-prompt'

const ENGAGEMENT: GpuFallbackEngagement = {
  reason: 'crashed',
  // 0x80000003 STATUS_BREAKPOINT — the production Windows signature.
  exitCode: -2147483645,
  crashesInWindow: 3,
  engagedAt: 1_700_000_000_000
}

function createHandlers(overrides: Partial<GpuFallbackEngagementHandlers> = {}): {
  handlers: GpuFallbackEngagementHandlers
  order: string[]
} {
  const order: string[] = []
  const handlers: GpuFallbackEngagementHandlers = {
    isQuitting: () => false,
    persistMarker: vi.fn(() => {
      order.push('persistMarker')
      return true
    }),
    confirmMarker: vi.fn(() => order.push('confirmMarker')),
    clearMarker: vi.fn(() => order.push('clearMarker')),
    promptForRestart: vi.fn(async () => {
      order.push('prompt')
      return 'restart' as GpuFallbackRestartDecision
    }),
    onPromptFailed: vi.fn(),
    onEngaged: vi.fn(),
    onRestartDeferred: vi.fn(() => order.push('restartDeferred')),
    restartIntoSafeGraphics: vi.fn(() => order.push('restart')),
    ...overrides
  }
  return { handlers, order }
}

describe('engageGpuFallbackAfterCrashBurst', () => {
  it('persists the safe-graphics marker before the restart prompt is answered', async () => {
    let resolvePrompt: ((decision: GpuFallbackRestartDecision) => void) | undefined
    const { handlers } = createHandlers({
      promptForRestart: vi.fn(
        () =>
          new Promise<GpuFallbackRestartDecision>((resolve) => {
            resolvePrompt = resolve
          })
      )
    })

    const engaging = engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    await Promise.resolve()

    expect(handlers.persistMarker).toHaveBeenCalledWith(ENGAGEMENT)

    resolvePrompt?.('restart')
    await engaging
  })

  it('relaunches into safe graphics when the user accepts', async () => {
    const { handlers, order } = createHandlers()
    await engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    expect(order).toEqual(['persistMarker', 'prompt', 'confirmMarker', 'restart'])
    expect(handlers.clearMarker).not.toHaveBeenCalled()
  })

  it('undoes the marker when the user chooses Keep Running', async () => {
    const { handlers, order } = createHandlers({
      promptForRestart: vi.fn(async () => 'continue' as GpuFallbackRestartDecision)
    })
    await engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    expect(order).toEqual(['persistMarker', 'clearMarker', 'restartDeferred'])
    expect(handlers.restartIntoSafeGraphics).not.toHaveBeenCalled()
  })

  it('keeps the marker when the prompt itself fails, so the next launch is still safe', async () => {
    const error = new Error('no display')
    const { handlers } = createHandlers({
      promptForRestart: vi.fn(async () => {
        throw error
      })
    })
    await engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    expect(handlers.persistMarker).toHaveBeenCalledTimes(1)
    expect(handlers.clearMarker).not.toHaveBeenCalled()
    expect(handlers.onPromptFailed).toHaveBeenCalledWith(error)
  })

  it('does not relaunch when a quit began while the prompt was open', async () => {
    const { handlers } = createHandlers({ isQuitting: () => true })
    await engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    expect(handlers.restartIntoSafeGraphics).not.toHaveBeenCalled()
    expect(handlers.clearMarker).not.toHaveBeenCalled()
  })

  it('does not claim a restart when the marker could not be written', async () => {
    const { handlers } = createHandlers({ persistMarker: vi.fn(() => false) })
    await engageGpuFallbackAfterCrashBurst(ENGAGEMENT, handlers)
    expect(handlers.restartIntoSafeGraphics).not.toHaveBeenCalled()
  })
})
