import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MobileMarkdownPreviewModeBar,
  useMarkdownPreviewMode
} from './MobileMarkdownPreviewModeBar'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  Alert: { alert },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  StyleSheet: { create: (value: unknown) => value },
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Copy: 'Copy',
  Check: 'Check'
}))

const { writeText, alert } = vi.hoisted(() => ({ writeText: vi.fn(), alert: vi.fn() }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))

vi.mock('../theme/mobile-theme', () => ({
  colors: { textPrimary: '#fff', textSecondary: '#999' },
  spacing: { xs: 4, sm: 8, md: 12 },
  radii: { control: 12 },
  concentricRadius: (outer: number, inset: number) => outer - inset,
  typography: { metaSize: 12 },
  getMobileColorScheme: () => 'dark',
  subscribeMobileColorScheme: () => () => {}
}))

vi.mock('./mobile-file-preview-styles', () => ({
  filePreviewStyles: {}
}))

type PreviewProps = {
  relativePath: string
  content: string
  truncated: boolean
  initialLine?: number
}

// The screen owns the mode and hands it to the bar; this mirrors that wiring.
function ModeBarHarness({ initialLine, ...props }: PreviewProps) {
  const [mode, setMode] = useMarkdownPreviewMode(props.relativePath, initialLine)
  return createElement(MobileMarkdownPreviewModeBar, { ...props, mode, onModeChange: setMode })
}

async function renderPreview(props: PreviewProps): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(ModeBarHarness, props))
  })
  if (!renderer) {
    throw new Error('MobileMarkdownPreviewModeBar did not render')
  }
  return renderer
}

async function updatePreview(renderer: ReactTestRenderer, props: PreviewProps): Promise<void> {
  await act(async () => {
    renderer.update(createElement(ModeBarHarness, props))
  })
}

function modeToggle(renderer: ReactTestRenderer, label: string) {
  const toggle = findAllByHostType(renderer.root, 'Pressable').find(
    (node) => node.props.accessibilityLabel === label
  )
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
  return modeToggle(renderer, label).props['aria-checked'] === true
}

describe('MobileMarkdownPreviewModeBar', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    writeText.mockClear()
    alert.mockClear()
    writeText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it.each(['View rendered Markdown preview', 'View Markdown source'])(
    'copies loaded source in %s mode after content updates',
    async (mode) => {
      const baseProps: PreviewProps = {
        relativePath: 'notes/file.md',
        content: '# Initial',
        truncated: false
      }
      renderer = await renderPreview(baseProps)
      await selectMode(renderer, mode)
      const source = '# Updated\n\n```js\n  let x = 1\n```\n\n| A | B |\n| - | - |\n| x | y |'
      await updatePreview(renderer, { ...baseProps, content: source })
      const copy = modeToggle(renderer, 'Copy Markdown source')
      expect(copy.props.accessibilityRole).toBe('button')
      await act(async () => copy.props.onPress())
      expect(writeText.mock.calls).toEqual([[source]])
    }
  )

  it('names the loaded portion when a file is truncated and copies only that source', async () => {
    const source = '# Loaded portion\n\n  still indented'
    renderer = await renderPreview({
      relativePath: 'notes/large.md',
      content: source,
      truncated: true
    })
    const copy = modeToggle(renderer, 'Copy loaded Markdown source')
    expect(
      findAllByHostType(renderer.root, 'Text').some((node) => node.props.children === 'Copy loaded')
    ).toBe(true)
    await act(async () => copy.props.onPress())
    expect(writeText.mock.calls).toEqual([[source]])
    await selectMode(renderer, 'View Markdown source')
    expect(modeToggle(renderer, 'Copy loaded Markdown source')).toBeDefined()
  })

  it('keeps native clipboard failure feedback and permits a retry', async () => {
    const source = '# Loaded source'
    renderer = await renderPreview({
      relativePath: 'notes/file.md',
      content: source,
      truncated: false
    })
    writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await selectMode(renderer, 'Copy Markdown source')
    expect(alert).toHaveBeenCalledExactlyOnceWith('Copy failed', 'Clipboard unavailable')
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === 'Copied')
    ).toBe(false)
    await selectMode(renderer, 'Copy Markdown source')
    expect(writeText.mock.calls).toEqual([[source], [source]])
  })

  it('resets the selected mode for a new file or line target without remounting the bar', async () => {
    const baseProps: PreviewProps = {
      relativePath: 'notes/first.md',
      content: '# First',
      truncated: false
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
