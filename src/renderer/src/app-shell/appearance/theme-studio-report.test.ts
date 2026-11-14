import { expect, it } from 'vitest'
import { parseThemeColor } from '../../../../shared/color/oklch-color-transform'
import { contrastRatio } from '../../../../shared/color/rgba-contrast'
import { themeStudioReport } from './theme-studio-report'

it('reports an unreadable pair with a fix that passes the check', () => {
  const report = themeStudioReport({
    revision: 4,
    draft: {
      name: 'Ember',
      light: null,
      dark: {
        tokens: {
          '--background': '#101010',
          '--foreground': '#eeeeee',
          '--worktree-sidebar': '#202020',
          '--worktree-sidebar-foreground': '#3a3a3a'
        }
      }
    },
    shownMode: 'dark',
    builtIns: () => ({}),
    probe: parseThemeColor
  })
  const issue = report.modes[0].issues.find(
    (entry) => entry.text === '--worktree-sidebar-foreground'
  )
  expect(issue).toMatchObject({ problem: 'contrast', surface: '--worktree-sidebar', min: 4.5 })
  expect(issue?.fix?.token).toBe('--worktree-sidebar-foreground')
  const fixed = parseThemeColor(issue?.fix?.value ?? '')
  const surface = parseThemeColor('#202020')
  expect(fixed && surface && contrastRatio(fixed, surface)).toBeGreaterThanOrEqual(4.5)
})
