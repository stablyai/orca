import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FileReader, scrollOffsetForSessionFileLine } from './MobileSessionFileReader'
import type { DiffCommentActions, FileDocState } from './mobile-session-route-types'

const scrollTo = vi.fn()

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
    ScrollView: React.forwardRef((props: Record<string, unknown>, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollTo }))
      return React.createElement('ScrollView', props)
    }),
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

it('scrolls to initialLine after layout and syntax highlighting and on repeated taps', async () => {
  scrollTo.mockClear()
  const fileDoc: FileDocState = {
    status: 'ready',
    kind: 'file',
    content: Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n'),
    truncated: false
  }
  await act(async () => {
    renderer = create(
      createElement(FileReader, {
        doc: fileDoc,
        title: 'index.tsx',
        relativePath: 'mobile/web-entry/index.tsx',
        initialLine: 136,
        initialLineSeq: 1
      })
    )
  })
  const scrollView = tree().root.find((node) => String(node.type) === 'ScrollView')
  scrollTo.mockClear()
  await act(async () => {
    scrollView.props.onContentSizeChange(360, 4400)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(scrollTo).toHaveBeenCalledWith({
    y: scrollOffsetForSessionFileLine(136),
    animated: false
  })

  scrollTo.mockClear()
  await act(async () => {
    scrollView.props.onContentSizeChange(360, 4400)
  })
  expect(scrollTo).not.toHaveBeenCalled()

  await act(async () => {
    tree().update(
      createElement(FileReader, {
        doc: fileDoc,
        title: 'index.tsx',
        relativePath: 'mobile/web-entry/index.tsx',
        initialLine: 136,
        initialLineSeq: 2
      })
    )
  })
  expect(scrollTo).toHaveBeenCalledWith({
    y: scrollOffsetForSessionFileLine(136),
    animated: false
  })
})
