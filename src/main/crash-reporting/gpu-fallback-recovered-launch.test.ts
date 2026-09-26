import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showMessageBox: showMessageBoxMock }
}))

import {
  handleGpuFallbackRecoveredLaunch,
  promptForGpuFallbackRecoveredLaunch,
  type GpuFallbackRecoveredLaunchDecision,
  type GpuFallbackRecoveredLaunchHandlers
} from './gpu-fallback-recovered-launch'

beforeEach(() => {
  showMessageBoxMock.mockReset()
})

function createHandlers(
  decision: GpuFallbackRecoveredLaunchDecision = 'keep-safe',
  overrides: Partial<GpuFallbackRecoveredLaunchHandlers> = {}
): { handlers: GpuFallbackRecoveredLaunchHandlers; order: string[] } {
  const order: string[] = []
  const handlers: GpuFallbackRecoveredLaunchHandlers = {
    isQuitting: () => false,
    prompt: vi.fn(async () => {
      order.push('prompt')
      return decision
    }),
    confirmSafeGraphics: vi.fn(() => order.push('confirm')),
    clearSafeGraphics: vi.fn(() => order.push('clear')),
    onPromptFailed: vi.fn(),
    onSafeGraphicsKept: vi.fn(() => order.push('kept')),
    restartWithHardware: vi.fn(() => order.push('restart')),
    ...overrides
  }
  return { handlers, order }
}

describe('promptForGpuFallbackRecoveredLaunch', () => {
  it('defaults dismissal to the stable safe-graphics choice', async () => {
    const parentWindow = { id: 1 }
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    await expect(promptForGpuFallbackRecoveredLaunch(parentWindow as never)).resolves.toBe(
      'keep-safe'
    )
    expect(showMessageBoxMock).toHaveBeenCalledWith(parentWindow, {
      type: 'info',
      buttons: ['Keep Safe Graphics Mode', 'Try Hardware Acceleration'],
      defaultId: 0,
      cancelId: 0,
      title: 'Safe Graphics Mode is Active',
      message: 'Orca recovered in Safe Graphics Mode.',
      detail:
        'Safe Graphics Mode was enabled after repeated graphics crashes. Keep it for stability, or restart and try hardware acceleration again.'
    })
  })

  it('returns the explicit hardware retry choice', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    await expect(promptForGpuFallbackRecoveredLaunch()).resolves.toBe('retry-hardware')
  })
})

describe('handleGpuFallbackRecoveredLaunch', () => {
  it('confirms safe graphics so later launches do not prompt again', async () => {
    const { handlers, order } = createHandlers()
    await handleGpuFallbackRecoveredLaunch(handlers)
    expect(order).toEqual(['prompt', 'confirm', 'kept'])
    expect(handlers.clearSafeGraphics).not.toHaveBeenCalled()
    expect(handlers.restartWithHardware).not.toHaveBeenCalled()
  })

  it('clears the marker before restarting with hardware acceleration', async () => {
    const { handlers, order } = createHandlers('retry-hardware')
    await handleGpuFallbackRecoveredLaunch(handlers)
    expect(order).toEqual(['prompt', 'clear', 'restart'])
    expect(handlers.confirmSafeGraphics).not.toHaveBeenCalled()
  })

  it('leaves the unconfirmed marker intact when the prompt fails', async () => {
    const error = new Error('dialog failed')
    const { handlers } = createHandlers('keep-safe', {
      prompt: vi.fn(async () => {
        throw error
      })
    })
    await handleGpuFallbackRecoveredLaunch(handlers)
    expect(handlers.onPromptFailed).toHaveBeenCalledWith(error)
    expect(handlers.confirmSafeGraphics).not.toHaveBeenCalled()
    expect(handlers.clearSafeGraphics).not.toHaveBeenCalled()
  })

  it('does not mutate the marker when shutdown starts while the prompt is open', async () => {
    const { handlers } = createHandlers('retry-hardware', { isQuitting: () => true })
    await handleGpuFallbackRecoveredLaunch(handlers)
    expect(handlers.confirmSafeGraphics).not.toHaveBeenCalled()
    expect(handlers.clearSafeGraphics).not.toHaveBeenCalled()
    expect(handlers.restartWithHardware).not.toHaveBeenCalled()
  })
})

describe('recovered safe-graphics production wiring', () => {
  it('prompts only after the recovered window is shown and persists both consent states', () => {
    const windowSource = readFileSync(
      join(__dirname, '..', 'startup', 'main-window-controller.ts'),
      'utf8'
    )
    const lifecycleSource = readFileSync(
      join(__dirname, '..', 'startup', 'gpu-lifecycle.ts'),
      'utf8'
    )
    expect(windowSource).toMatch(
      /window\.once\('show',[\s\S]*?presentGpuFallbackRecoveredLaunchPrompt\(window\)/
    )
    expect(lifecycleSource).toMatch(
      /persistMarker:[\s\S]*?userConfirmed: false[\s\S]*?confirmMarker:[\s\S]*?userConfirmed: true/
    )
  })
})
