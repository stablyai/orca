import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Code: 'Code',
  Pencil: 'Pencil'
}))

vi.mock('../components/MobileMarkdown', () => ({
  MobileMarkdown: 'MobileMarkdown'
}))

vi.mock('./MobileFilePreviewSourceText', () => ({
  MobileFilePreviewSourceText: 'MobileFilePreviewSourceText',
  MobileFilePreviewTruncatedNote: 'MobileFilePreviewTruncatedNote'
}))

vi.mock('../theme/mobile-theme', () => ({
  colors: { textPrimary: '#fff', textSecondary: '#999' }
}))

vi.mock('./mobile-file-preview-styles', () => ({
  filePreviewStyles: {}
}))

type PreviewProps = Parameters<typeof MobileFileMarkdownPreview>[0]

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

async function renderPreview(props: PreviewProps): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(MobileFileMarkdownPreview, props))
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('MobileFileMarkdownPreview did not render')
  }
  return renderer
}

async function updatePreview(renderer: ReactTestRenderer, props: PreviewProps): Promise<void> {
  await act(async () => {
    renderer.update(createElement(MobileFileMarkdownPreview, props))
  })
}

function modeToggle(renderer: ReactTestRenderer, label: string) {
  const toggle = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === label)
  if (!toggle) {
    throw new Error(`Missing ${label} toggle`)
  }
  return toggle
}

async function selectMode(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    modeToggle(renderer, label).props.onPress()
  })
}

function isSelected(renderer: ReactTestRenderer, label: string): boolean {
  return modeToggle(renderer, label).props.accessibilityState.selected === true
}

describe('MobileFileMarkdownPreview', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.restoreAllMocks()
  })

  it('resets the selected mode for a new file or line target without remounting the preview', async () => {
    const baseProps: PreviewProps = {
      relativePath: 'notes/first.md',
      content: '# First',
      truncated: false,
      byteLength: 7
    }
    renderer = await renderPreview(baseProps)

    expect(isSelected(renderer, 'View rendered Markdown preview')).toBe(true)
    await selectMode(renderer, 'View Markdown source')
    expect(isSelected(renderer, 'View Markdown source')).toBe(true)

    // Content updates alone preserve the user's explicitly selected mode.
    await updatePreview(renderer, { ...baseProps, content: '# First updated' })
    expect(isSelected(renderer, 'View Markdown source')).toBe(true)

    await updatePreview(renderer, { ...baseProps, relativePath: 'notes/second.md' })
    expect(isSelected(renderer, 'View rendered Markdown preview')).toBe(true)

    await updatePreview(renderer, { ...baseProps, relativePath: 'notes/second.md', initialLine: 8 })
    expect(isSelected(renderer, 'View Markdown source')).toBe(true)
  })
})
