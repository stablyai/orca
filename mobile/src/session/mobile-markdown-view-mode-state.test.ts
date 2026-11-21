import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  clearMobileMarkdownViewModeState,
  getInitialMobileMarkdownViewMode,
  getMobileMarkdownScrollRatio,
  MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY,
  MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY,
  parseMobileMarkdownViewMode,
  readMobileMarkdownViewModePreferences,
  saveMobileMarkdownScrollRatio,
  saveMobileMarkdownViewMode
} from './mobile-markdown-view-mode-state'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

describe('mobile-markdown-view-mode-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMobileMarkdownViewModeState()
  })

  it('parses valid and invalid mode strings', () => {
    expect(parseMobileMarkdownViewMode('source')).toBe('source')
    expect(parseMobileMarkdownViewMode('editor')).toBe('editor')
    expect(parseMobileMarkdownViewMode('unknown')).toBe('editor')
    expect(parseMobileMarkdownViewMode(null)).toBe('editor')
  })

  it('defaults to editor initially', () => {
    expect(getInitialMobileMarkdownViewMode()).toBe('editor')
    expect(getInitialMobileMarkdownViewMode('README.md')).toBe('editor')
  })

  it('remembers view mode per document key in memory', () => {
    saveMobileMarkdownViewMode('README.md', 'source')
    expect(getInitialMobileMarkdownViewMode('README.md')).toBe('source')
    // Unseen documents inherit the last chosen mode ('source')
    expect(getInitialMobileMarkdownViewMode('CONTRIBUTING.md')).toBe('source')

    // Toggling another document updates only that document and the default
    saveMobileMarkdownViewMode('CONTRIBUTING.md', 'editor')
    expect(getInitialMobileMarkdownViewMode('CONTRIBUTING.md')).toBe('editor')
    expect(getInitialMobileMarkdownViewMode('README.md')).toBe('source')
  })

  it('persists preferences to AsyncStorage on save', async () => {
    await saveMobileMarkdownViewMode('docs/intro.md', 'source')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY,
      'source'
    )
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY,
      JSON.stringify([['docs/intro.md', 'source']])
    )
  })

  it('hydrates saved preferences from AsyncStorage', async () => {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
      if (key === MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY) {
        return 'source'
      }
      if (key === MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY) {
        return JSON.stringify([['notes.md', 'editor']])
      }
      return null
    })

    await readMobileMarkdownViewModePreferences()

    // notes.md was explicitly saved as editor
    expect(getInitialMobileMarkdownViewMode('notes.md')).toBe('editor')
    // other documents fall back to last chosen mode 'source'
    expect(getInitialMobileMarkdownViewMode('other.md')).toBe('source')
  })

  it('tracks and clamps scroll ratio per document in memory', () => {
    expect(getMobileMarkdownScrollRatio('README.md')).toBe(0)

    saveMobileMarkdownScrollRatio('README.md', 0.42)
    expect(getMobileMarkdownScrollRatio('README.md')).toBe(0.42)
    expect(getMobileMarkdownScrollRatio('CONTRIBUTING.md')).toBe(0)

    // Clamps to [0, 1]
    saveMobileMarkdownScrollRatio('README.md', 1.5)
    expect(getMobileMarkdownScrollRatio('README.md')).toBe(1)

    saveMobileMarkdownScrollRatio('README.md', -0.2)
    expect(getMobileMarkdownScrollRatio('README.md')).toBe(0)
  })
})
