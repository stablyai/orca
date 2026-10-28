import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FileReader } from './MobileSessionFileReader'
import type { DiffCommentActions, FileDocState } from './mobile-session-route-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    FlatList: (props: { data: unknown[]; renderItem: (item: unknown) => ReactNode }) =>
      React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement('Line', { key: index }, props.renderItem({ item, index }))
        )
      ),
    Image: 'Image',
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: unknown) => styles },
    ActivityIndicator: 'ActivityIndicator'
  }
})
vi.mock('lucide-react-native', () => ({
  Copy: 'Copy',
  MessageSquare: 'MessageSquare',
  Send: 'Send',
  Plus: 'Plus',
  X: 'X'
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../files/MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
vi.mock('../components/MobileHtmlPreview', () => ({ MobileHtmlPreview: () => null }))

let renderer: ReactTestRenderer | undefined

afterEach(() => act(() => renderer?.unmount()))

const doc: FileDocState = {
  status: 'ready',
  kind: 'diff',
  lines: [{ kind: 'add', text: 'const value = 1', newLineNumber: 1 }],
  truncated: false
}

function actions(onAdd: DiffCommentActions['onAdd']): DiffCommentActions {
  return {
    comments: [],
    sendingCommentIds: new Set(),
    busy: false,
    onAdd,
    onDelete: async () => {},
    onCopyAll: async () => {},
    onSendAll: () => {}
  }
}

function tree(): ReactTestRenderer {
  if (!renderer) {
    throw new Error('File reader not mounted')
  }
  return renderer
}

function press(label: string) {
  const button = tree()
    .root.findAll((node) => String(node.type) === 'Pressable')
    .find(
      (node) =>
        node.props.accessibilityLabel === label ||
        node
          .findAll((node) => String(node.type) === 'Text')
          .some((text) => text.props.children === label)
    )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return act(async () => button.props.onPress())
}

it('does not offer a review draft from another file for saving', async () => {
  const onAdd = vi.fn(async () => true)
  const diffCommentActions = actions(onAdd)
  await act(async () => {
    renderer = create(
      createElement(FileReader, { doc, title: 'A', relativePath: 'a.ts', diffCommentActions })
    )
  })
  await press('Add note on line 1')
  act(() =>
    tree()
      .root.find((node) => String(node.type) === 'TextInput')
      .props.onChangeText('Fix validation in A')
  )
  await act(async () => {
    tree().update(
      createElement(FileReader, { doc, title: 'B', relativePath: 'b.ts', diffCommentActions })
    )
  })
  expect(tree().root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
  await press('Add note on line 1')
  expect(tree().root.find((node) => String(node.type) === 'TextInput').props.value).toBe('')
  act(() =>
    tree()
      .root.find((node) => String(node.type) === 'TextInput')
      .props.onChangeText('Fix validation in B')
  )
  await press('Save note')
  expect(onAdd.mock.calls).toEqual([['b.ts', 1, 'Fix validation in B']])
})

it('does not let an old file submission clear the new file composer', async () => {
  let finishSave: (saved: boolean) => void = () => {}
  const oldSave = new Promise<boolean>((resolve) => {
    finishSave = resolve
  })
  const diffCommentActions = actions(() => oldSave)
  await act(async () => {
    renderer = create(
      createElement(FileReader, { doc, title: 'A', relativePath: 'a.ts', diffCommentActions })
    )
  })
  await press('Add note on line 1')
  act(() =>
    tree()
      .root.find((node) => String(node.type) === 'TextInput')
      .props.onChangeText('Note A')
  )
  await press('Save note')
  await act(async () => {
    tree().update(
      createElement(FileReader, { doc, title: 'B', relativePath: 'b.ts', diffCommentActions })
    )
  })
  await press('Add note on line 1')
  act(() =>
    tree()
      .root.find((node) => String(node.type) === 'TextInput')
      .props.onChangeText('Note B')
  )
  await act(async () => {
    finishSave(true)
    await oldSave
  })
  expect(tree().root.find((node) => String(node.type) === 'TextInput').props.value).toBe('Note B')
})

it('separates diff documents with the same path through the explicit document identity', async () => {
  const diffCommentActions = actions(async () => true)
  await act(async () => {
    renderer = create(
      createElement(FileReader, {
        doc,
        title: 'a.ts',
        relativePath: 'a.ts',
        documentId: 'wt:staged-a',
        diffCommentActions
      })
    )
  })
  await press('Add note on line 1')
  act(() =>
    tree()
      .root.find((node) => String(node.type) === 'TextInput')
      .props.onChangeText('Staged note')
  )
  await act(async () => {
    tree().update(
      createElement(FileReader, {
        doc,
        title: 'a.ts',
        relativePath: 'a.ts',
        documentId: 'wt:unstaged-a',
        diffCommentActions
      })
    )
  })
  expect(tree().root.findAll((node) => String(node.type) === 'TextInput')).toHaveLength(0)
  await press('Add note on line 1')
  expect(tree().root.find((node) => String(node.type) === 'TextInput').props.value).toBe('')
})
