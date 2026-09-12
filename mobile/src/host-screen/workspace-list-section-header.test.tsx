import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spacing } from '../theme/mobile-theme'
import { WorkspaceListSectionHeader } from './workspace-list-section-header'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  FolderTree: 'FolderTree',
  Pin: 'Pin'
}))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: 'MobileRepoIcon' }))

describe('WorkspaceListSectionHeader', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('indents nested project groups and names the collapsed folder for the screen reader', async () => {
    await act(async () => {
      renderer = create(
        createElement(WorkspaceListSectionHeader, {
          title: 'Clients',
          count: 2,
          depth: 1,
          kind: 'project-group',
          icon: 'folder',
          collapsed: true,
          repoColor: null,
          repoIcon: null,
          onPress: () => undefined
        })
      )
    })
    const pressable = renderer!.root.findByType('Pressable')
    expect(pressable.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingLeft: spacing.lg + spacing.lg })])
    )
    expect(pressable.props.accessibilityLabel).toBe('Clients, 2')
    expect(pressable.props.accessibilityState).toEqual({ expanded: false })
    expect(renderer!.root.findByType('FolderTree')).toBeTruthy()
    expect(renderer!.root.findByType('ChevronRight')).toBeTruthy()
  })
})
