import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const viewport = vi.hoisted(() => ({ width: 669, height: 951, ownsHostArea: true }))
vi.mock('react-native', () => ({ useWindowDimensions: () => viewport }))
vi.mock('./page-owns-host-area', () => ({ usePageOwnsHostArea: () => viewport.ownsHostArea }))
vi.mock('../host-screen/HostScreen', () => ({ HostScreen: () => createElement('WorkspacePicker') }))
vi.mock('../components/WorkspaceDetailPlaceholder', () => ({
  WorkspaceDetailPlaceholder: () => createElement('WorkspacePlaceholder')
}))

import HostWorktreeRoute from '../../app/h/[hostId]/index.web'

describe('host root content across layouts', () => {
  it.each([
    { width: 390, height: 844, ownsHostArea: true, expected: 'WorkspacePicker' },
    { width: 669, height: 951, ownsHostArea: true, expected: 'WorkspacePicker' },
    { width: 951, height: 669, ownsHostArea: true, expected: 'WorkspacePlaceholder' },
    { width: 951, height: 669, ownsHostArea: false, expected: 'WorkspacePicker' }
  ])('renders $expected at $width with ownership $ownsHostArea', (state) => {
    Object.assign(viewport, state)
    let tree: ReactTestRenderer | undefined
    act(() => {
      tree = create(createElement(HostWorktreeRoute))
    })
    expect(tree?.toJSON()).toMatchObject({ type: state.expected })
    act(() => tree?.unmount())
  })

  it('returns the picker after rotating a host root from landscape to portrait', () => {
    Object.assign(viewport, { width: 951, height: 669, ownsHostArea: true })
    let tree: ReactTestRenderer | undefined
    act(() => {
      tree = create(createElement(HostWorktreeRoute))
    })
    expect(tree?.toJSON()).toMatchObject({ type: 'WorkspacePlaceholder' })
    Object.assign(viewport, { width: 669, height: 951 })
    act(() => tree?.update(createElement(HostWorktreeRoute)))
    expect(tree?.toJSON()).toMatchObject({ type: 'WorkspacePicker' })
    act(() => tree?.unmount())
  })
})
