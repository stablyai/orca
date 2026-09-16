import { describe, expect, it } from 'vitest'
import { getHostSidebarPresentation } from './host-sidebar-presentation'

describe('host sidebar presentation', () => {
  it('keeps the sidebar visible on the base host route', () => {
    expect(getHostSidebarPresentation(true, false, false)).toBe('sidebar')
  })

  it('shows the reveal control for collapsed detail content', () => {
    expect(getHostSidebarPresentation(true, true, false)).toBe('reveal')
  })

  it('hides both controls outside wide host layouts', () => {
    expect(getHostSidebarPresentation(false, true, false)).toBe('hidden')
  })
})
