import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children?: ReactNode }) => createElement('View', null, children)
}))

import { MultiRepoDeleteSheet } from './MultiRepoDeleteSheet'

function textOf(node: ReactTestInstance): string {
  return node
    .findAllByType('Text')
    .map((text) => text.children.join(''))
    .join('|')
}

describe('MultiRepoDeleteSheet', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('reports an unavailable host instead of staying on Checking when there is no client', () => {
    act(() => {
      renderer = create(
        createElement(MultiRepoDeleteSheet, {
          client: null,
          folderWorkspaceId: 'ws-1',
          workspaceName: 'ws',
          memberNames: new Map(),
          onClose: () => {}
        })
      )
    })
    const text = textOf(renderer!.root)
    expect(text).toContain('This host is not available for workspace deletion')
    expect(text).not.toContain('Checking')
  })
})
