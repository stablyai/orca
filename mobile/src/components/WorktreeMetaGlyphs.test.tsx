import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'CalendarClock',
  CircleDot: 'CircleDot',
  GitMerge: 'GitMerge',
  SquareTerminal: 'SquareTerminal',
  StickyNote: 'StickyNote'
}))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

import { WorktreeMetaGlyphs } from './WorktreeMetaGlyphs'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

const NONE = {
  notes: false,
  automation: false,
  cli: false,
  issue: false,
  jira: false,
  linear: false,
  gitLabMR: false
}

function glyphs(presence: Partial<typeof NONE>): string[] {
  act(() => {
    renderer = create(createElement(WorktreeMetaGlyphs, { presence: { ...NONE, ...presence } }))
  })
  return renderer!.root
    .findAll((node) => typeof node.type === 'string' && String(node.type) !== 'View')
    .map((node) =>
      String(node.type) === 'TaskProviderLogo'
        ? `logo:${String(node.props.provider)}`
        : String(node.type)
    )
}

describe('WorktreeMetaGlyphs', () => {
  it('draws the glyphs in the desktop order', () => {
    expect(
      glyphs({ notes: true, automation: true, cli: true, issue: true, jira: true, linear: true })
    ).toEqual(['StickyNote', 'CalendarClock', 'SquareTerminal', 'CircleDot', 'logo:jira', 'Text'])
  })

  it('draws nothing when the row has none of them', () => {
    act(() => {
      renderer = create(createElement(WorktreeMetaGlyphs, { presence: NONE }))
    })
    expect(renderer!.toJSON()).toBeNull()
  })
})
