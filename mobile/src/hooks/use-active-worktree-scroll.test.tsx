import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useActiveWorktreeScroll } from './use-active-worktree-scroll'

type Row = { worktreeId: string; isActive?: boolean }
type Sections = { key: string; data: Row[] }[]

/** Rows a, b, c with `active` highlighted; a folded section shows none of them. */
const listOf = (active: string | null, folded = false): Sections => [
  {
    key: 'all',
    data: folded
      ? []
      : ['a', 'b', 'c'].map((worktreeId) => ({ worktreeId, isActive: worktreeId === active }))
  }
]

const NONE = new Set<string>()
const FOLDED = new Set(['all'])

function mount(sections: Sections, collapsedGroups: ReadonlySet<string> = NONE) {
  const scrollToLocation = vi.fn()
  function Probe(props: { sections: Sections; collapsedGroups: ReadonlySet<string> }): null {
    const { sectionListRef } = useActiveWorktreeScroll(props.sections, props.collapsedGroups)
    // The hook calls only scrollToLocation on its list.
    Object.assign(sectionListRef, { current: { scrollToLocation } })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe, { sections, collapsedGroups }))
  })
  const update = (next: Sections, nextCollapsed: ReadonlySet<string> = NONE) =>
    act(() => {
      renderer?.update(createElement(Probe, { sections: next, collapsedGroups: nextCollapsed }))
    })
  return { scrollToLocation, update }
}

describe('useActiveWorktreeScroll', () => {
  it('scrolls to the highlighted row, and again when another workspace is highlighted', () => {
    const list = mount(listOf('b'))
    expect(list.scrollToLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ sectionIndex: 0, itemIndex: 1 })
    )
    list.update(listOf('c'))
    expect(list.scrollToLocation).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemIndex: 2 })
    )
    expect(list.scrollToLocation).toHaveBeenCalledTimes(2)
  })

  it('never scrolls when a fold or search hides the row and it comes back', () => {
    const list = mount(listOf('b'))
    list.update(listOf('b', true), FOLDED)
    list.update(listOf('b'), NONE)
    // A search hiding the row, then cleared.
    list.update(listOf(null))
    list.update(listOf('b'))
    expect(list.scrollToLocation).toHaveBeenCalledTimes(1)
  })

  it('never scrolls to a highlight an unfold first reveals', () => {
    const list = mount(listOf('b', true), FOLDED)
    list.update(listOf('b'), NONE)
    expect(list.scrollToLocation).not.toHaveBeenCalled()
    // A later move to another workspace still scrolls.
    list.update(listOf('c'), NONE)
    expect(list.scrollToLocation).toHaveBeenCalledTimes(1)
  })
})
