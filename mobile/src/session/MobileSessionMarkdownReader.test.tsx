import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownReader } from './MobileSessionMarkdownReader'
import type { MarkdownDocState } from './mobile-session-route-types'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))
vi.mock('../components/MobileRichMarkdownEditor', () => ({
  MobileRichMarkdownEditor: 'MobileRichMarkdownEditor'
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('./MobileSessionMarkdownPreview', () => ({
  MobileSessionMarkdownPreview: 'MobileSessionMarkdownPreview'
}))
const { pushFile } = vi.hoisted(() => ({ pushFile: vi.fn() }))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: pushFile })
}))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))

const doc: MarkdownDocState = {
  status: 'ready',
  content: '# Saved',
  localContent: '# Saved',
  baseVersion: '1',
  isDirty: false,
  editable: true
}

describe('live session markdown reader copy', () => {
  let renderer: ReactTestRenderer | undefined
  const onCopy = vi.fn(),
    onCopyPath = vi.fn(),
    onSave = vi.fn(),
    onDiscard = vi.fn(),
    onRefresh = vi.fn(),
    onChange = vi.fn()
  function render(value: MarkdownDocState | undefined = doc) {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'doc',
          hostId: 'remote',
          worktreeId: 'folder:project',
          relativePath: 'docs/notes.md',
          filePath: '/remote/project/docs/notes.md',
          doc: value,
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange,
          keyboardLift: 0
        })
      )
    })
  }
  const buttons = () => renderer!.root.findAll((node) => String(node.type) === 'Pressable')
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => act(() => renderer?.unmount()))

  it.each([
    ['editable', {}],
    ['dirty', { isDirty: true, localContent: '# Unsaved' }],
    ['read-only', { editable: false }],
    ['saving', { isDirty: true, saving: true }],
    ['truncated', { truncated: true }]
  ] as const)(
    'offers adjacent source and path copy actions on a ready %s document',
    (_name, fields) => {
      render({ ...doc, ...fields })
      const copy = buttons().find(
        (node) =>
          node.props.accessibilityLabel ===
          ('truncated' in fields ? 'Copy loaded Markdown source' : 'Copy Markdown source')
      )
      expect(copy).toBeDefined()
      expect(copy?.props.accessibilityRole).toBe('button')
      expect(copy?.props.disabled).not.toBe(true)
      act(() => copy?.props.onPress())
      expect(onCopy).toHaveBeenCalledOnce()
      const pathCopy = buttons()[buttons().indexOf(copy!) + 1]!
      expect(pathCopy.props.accessibilityLabel).toBe('Copy Markdown path')
      expect(pathCopy.props.accessibilityRole).toBe('button')
      expect(pathCopy.props.disabled).not.toBe(true)
      act(() => pathCopy.props.onPress())
      expect(onCopyPath).toHaveBeenCalledOnce()
      expect(onCopy).toHaveBeenCalledOnce()
      expect(onSave).not.toHaveBeenCalled()
      expect(onDiscard).not.toHaveBeenCalled()
    }
  )

  it('opens in reading mode and carries edits from the editor into the preview', () => {
    render({ ...doc, isDirty: true, localContent: '# Draft' })
    const preview = () => renderer!.root.findByType('MobileSessionMarkdownPreview')
    expect(preview().props.content).toBe('# Draft')
    act(() =>
      buttons()
        .find((button) => button.props.accessibilityLabel === 'Edit Markdown')!
        .props.onPress()
    )
    const editor = renderer!.root.findByType('MobileRichMarkdownEditor')
    expect(editor.props.content).toBe('# Draft')
    act(() => editor.props.onChange('# Edited'))
    expect(onChange.mock.calls).toEqual([['# Edited']])
    const props = renderer!.root.findByType(MarkdownReader).props
    act(() =>
      renderer!.update(
        createElement(MarkdownReader, {
          ...props,
          doc: { ...doc, isDirty: true, localContent: '# Edited' }
        })
      )
    )
    expect(renderer!.root.findByType('MobileRichMarkdownEditor').props.content).toBe('# Edited')
    act(() =>
      buttons()
        .find((button) => button.props.accessibilityLabel === 'Preview Markdown')!
        .props.onPress()
    )
    expect(preview().props.content).toBe('# Edited')
    expect(onSave).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('keeps Preview available when the document turns read-only while editing', () => {
    render()
    const toggle = () =>
      buttons().find((button) =>
        ['Edit Markdown', 'Preview Markdown'].includes(button.props.accessibilityLabel)
      )!
    act(() => toggle().props.onPress())
    const props = renderer!.root.findByType(MarkdownReader).props
    act(() =>
      renderer!.update(
        createElement(MarkdownReader, { ...props, doc: { ...doc, editable: false } })
      )
    )
    expect(toggle().props.accessibilityLabel).toBe('Preview Markdown')
    expect(toggle().props.disabled).toBe(false)
    act(() => toggle().props.onPress())
    expect(toggle().props.accessibilityLabel).toBe('Edit Markdown')
    expect(toggle().props.disabled).toBe(true)
  })

  it('opens a workspace file from the live document on the same remote host', () => {
    const photoRoute = {
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'remote',
        worktreeId: 'folder:project',
        source: 'worktree',
        relativePath: 'assets/photo.png'
      }
    }
    render()
    act(() =>
      renderer!.root
        .findByType('MobileSessionMarkdownPreview')
        .props.onOpenFile('/remote/project/assets/photo.png')
    )
    expect(pushFile).toHaveBeenLastCalledWith(photoRoute)
    act(() =>
      buttons()
        .find((button) => button.props.accessibilityLabel === 'Edit Markdown')!
        .props.onPress()
    )
    act(() =>
      renderer!.root
        .findByType('MobileRichMarkdownEditor')
        .props.onOpenWorkspaceFile('../assets/photo.png')
    )
    expect(pushFile).toHaveBeenCalledTimes(2)
    expect(pushFile).toHaveBeenLastCalledWith(photoRoute)
  })

  it('keeps loading and error states free of copy actions', () => {
    render({ status: 'loading' })
    expect(buttons()).toHaveLength(0)
    act(() =>
      renderer!.update(
        createElement(MarkdownReader, {
          documentId: 'doc',
          doc: { status: 'error', message: 'Unavailable' },
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    )
    expect(buttons()).toHaveLength(1)
    act(() => buttons()[0]!.props.onPress())
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onCopy).not.toHaveBeenCalled()
    expect(onCopyPath).not.toHaveBeenCalled()
  })
})
