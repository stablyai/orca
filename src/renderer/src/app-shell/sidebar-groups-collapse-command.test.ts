import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerSidebarGroupCollapseScope } from '@/lib/sidebar-group-collapse'
import { createSidebarGroupsCollapseCommand } from './sidebar-groups-collapse-command'

const overlay = vi.hoisted(() => ({ visible: false }))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlay: () => overlay.visible }))

let unregister: () => void
const claim = (_actionId: string, run: () => void): boolean => {
  run()
  return true
}

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  overlay.visible = false
  useAppStore.setState({
    activeModal: 'none',
    collapsedGroups: new Set(['repo:b', 'lineage:parent'])
  })
  unregister = registerSidebarGroupCollapseScope(['repo:a', 'repo:b'])
})

afterEach(() => {
  unregister()
  vi.unstubAllGlobals()
})

describe('sidebar groups collapse command', () => {
  it('uses the shared mixed-state toggle for successive command invocations', () => {
    const command = createSidebarGroupsCollapseCommand(claim, false, false)
    expect(command()).toBe(true)
    expect([...useAppStore.getState().collapsedGroups]).toEqual([
      'repo:b',
      'lineage:parent',
      'repo:a'
    ])
    expect(command()).toBe(true)
    expect([...useAppStore.getState().collapsedGroups]).toEqual(['lineage:parent'])
  })

  it.each(['modal', 'overlay', 'creation', 'floating', 'empty'] as const)(
    'leaves collapse state alone when blocked by %s',
    (guard) => {
      if (guard === 'modal') {
        useAppStore.setState({ activeModal: 'add-repo' })
      }
      if (guard === 'overlay') {
        overlay.visible = true
      }
      if (guard === 'empty') {
        unregister()
        unregister = registerSidebarGroupCollapseScope([])
      }
      expect(
        createSidebarGroupsCollapseCommand(claim, guard === 'creation', guard === 'floating')()
      ).toBe(false)
      expect([...useAppStore.getState().collapsedGroups]).toEqual(['repo:b', 'lineage:parent'])
    }
  )
})
