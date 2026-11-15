import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkThemeStudioPrediction, predictThemeStudioDrops } from './theme-studio-prediction'

const dark = (tokens: Record<string, string>) => ({
  name: 'Dusk',
  light: null,
  dark: { tokens: { '--background': '#101010', '--foreground': '#f0f0f0', ...tokens } }
})

describe('theme studio drop prediction', () => {
  afterEach(() => vi.restoreAllMocks())

  it('predicts the tokens the gate leaves unpainted, per mode', () => {
    const predicted = predictThemeStudioDrops(
      dark({ '--worktree-sidebar': '#2a2a2a', '--worktree-sidebar-foreground': '#3a3a3a' })
    )
    expect(predicted.light).toBeUndefined()
    expect(predicted.dark).toContain('--worktree-sidebar-foreground')
    expect(predictThemeStudioDrops(dark({})).dark).toEqual([])
  })

  it('logs only when a painted result differs from the prediction', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const predicted = { dark: ['--ring'] }
    checkThemeStudioPrediction(
      { status: 'painted', mode: 'dark', dropped: ['--ring'], windows: 1 },
      predicted
    )
    checkThemeStudioPrediction({ status: 'timeout', dropped: [], windows: 1 }, predicted)
    expect(warn).not.toHaveBeenCalled()
    checkThemeStudioPrediction(
      { status: 'painted', mode: 'dark', dropped: [], windows: 1 },
      predicted
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
