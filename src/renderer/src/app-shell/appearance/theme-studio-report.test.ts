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
  const finding = report.modes[0].findings.find(
    (entry) => entry.text === '--worktree-sidebar-foreground'
  )
  expect(finding).toMatchObject({
    id: 'dark-text-worktree-sidebar-foreground-on-worktree-sidebar',
    rule: 'text',
    surface: '--worktree-sidebar',
    min: 4.5
  })
  expect(finding?.fixes.map((fix) => fix.strategy).sort()).toEqual([
    'surface-lightness',
    'text-lightness'
  ])
  const textFix = finding?.fixes.find((fix) => fix.strategy === 'text-lightness')
  const surface = parseThemeColor('#202020')
  const fixedText = parseThemeColor(textFix?.set['--worktree-sidebar-foreground'] ?? '')
  expect(fixedText && surface && contrastRatio(fixedText, surface)).toBeGreaterThanOrEqual(4.5)
})
