import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MobileMarkdownPreviewModeBar } from './MobileMarkdownPreviewModeBar'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({ View: 'View' }))
vi.mock('../components/MobileSegmentedControl', () => ({
  MobileSegmentedControl: 'MobileSegmentedControl'
}))
vi.mock('../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'MobileSourceCopyButton'
}))
vi.mock('../markdown-text-scale/MarkdownTextSizeButton', () => ({
  MarkdownTextSizeButton: 'MarkdownTextSizeButton'
}))
vi.mock('../markdown-text-scale/use-markdown-text-scale', () => ({
  useMarkdownTextScale: () => ({ textScale: 1, commitTextScale: vi.fn() })
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: vi.fn() }))
vi.mock('./mobile-file-preview-styles', () => ({ filePreviewStyles: {} }))

it('shows the text size button only in preview mode', async () => {
  const props = {
    onModeChange: vi.fn(),
    relativePath: 'file.md',
    content: '# Title',
    truncated: false
  }
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(MobileMarkdownPreviewModeBar, { ...props, mode: 'preview' }))
  })
  expect(findAllByHostType(renderer.root, 'MarkdownTextSizeButton')).toHaveLength(1)
  await act(async () => {
    renderer.update(createElement(MobileMarkdownPreviewModeBar, { ...props, mode: 'source' }))
  })
  expect(findAllByHostType(renderer.root, 'MarkdownTextSizeButton')).toHaveLength(0)
  act(() => renderer.unmount())
})
