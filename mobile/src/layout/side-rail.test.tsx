import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SideRailOnTopContext, SideRailProvider, useSideRailClaim } from './side-rail'

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))

function RailLabel(_props: { text: string }) {
  return null
}

function Claimant({ label }: { label: string | null }) {
  useSideRailClaim(label === null ? null : createElement(RailLabel, { text: label }))
  return null
}

function screen(label: string | null, onTop: boolean) {
  return createElement(
    SideRailOnTopContext.Provider,
    { value: onTop },
    createElement(Claimant, { label })
  )
}

describe('side rail', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(edge: 'right' | null, ...screens: ReturnType<typeof screen>[]) {
    const tree = (
      <SideRailProvider edge={edge} width={84} bottom={34}>
        {screens}
      </SideRailProvider>
    )
    act(() => {
      if (renderer) {
        renderer.update(tree)
      } else {
        renderer = create(tree)
      }
    })
  }

  function railText(): string[] {
    return (renderer?.root.findAllByType(RailLabel) ?? []).map((node) => node.props.text)
  }

  it('shows the top screen, never one a stack keeps beneath it', () => {
    render('right', screen('host actions', true), screen('keys', false))
    expect(railText()).toEqual(['host actions'])
  })

  it('gives the rail back when a claim ends, and draws nothing without a rail', () => {
    render('right', screen('keys', true))
    expect(railText()).toEqual(['keys'])
    render('right', screen(null, true))
    expect(railText()).toEqual([])
    render(null, screen('keys', true))
    expect(railText()).toEqual([])
  })
})
