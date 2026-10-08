import { describe, expect, it } from 'vitest'
import { pageSafeAreaInsets } from './page-safe-area-insets'

const WINDOW = { top: 52, right: 12, bottom: 24, left: 12 }

describe('the insets the page pads for', () => {
  it('is the window insets while nothing of the shell stands over the view', () => {
    expect(pageSafeAreaInsets({ insets: WINDOW, topCovered: false })).toEqual(WINDOW)
  })

  it('has no top while the shell banner takes the status bar strip', () => {
    expect(pageSafeAreaInsets({ insets: WINDOW, topCovered: true })).toEqual({ ...WINDOW, top: 0 })
  })
})
