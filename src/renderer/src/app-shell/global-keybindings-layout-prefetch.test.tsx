// The global dispatcher resolves Option chords through the active layout, so the layout
// cache must be warm at renderer startup rather than when a terminal pane first mounts.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { keybindingMatchesAction } from '../../../shared/keybindings'
import type * as LayoutBaseCharacter from '@/lib/keyboard-layout/layout-base-character'

const prefetchLayoutCharacters = vi.fn()

vi.mock('@/lib/keyboard-layout/layout-base-character', async (importOriginal) => {
  const actual = await importOriginal<typeof LayoutBaseCharacter>()
  return { ...actual, prefetchLayoutCharacters }
})

describe('renderer startup warms the keyboard layout cache', () => {
  beforeEach(() => {
    prefetchLayoutCharacters.mockClear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefetches the layout characters on macOS without a terminal pane', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    const { warmKeyboardLayoutCache } = await import('./global-keybindings-layout-prefetch')
    warmKeyboardLayoutCache('darwin')
    expect(prefetchLayoutCharacters).toHaveBeenCalledOnce()
  })

  it('does not prefetch on Windows or Linux, where Option does not compose', async () => {
    const { warmKeyboardLayoutCache } = await import('./global-keybindings-layout-prefetch')
    warmKeyboardLayoutCache('win32')
    warmKeyboardLayoutCache('linux')
    expect(prefetchLayoutCharacters).not.toHaveBeenCalled()
  })
})

describe('the global dispatcher resolves a Dvorak Option chord before any terminal exists', () => {
  it('matches Alt+Z on the key that types z, not the physical Z key', () => {
    // Dvorak: physical Semicolon types 'z'; physical KeyZ types ';'.
    const dvorak = (code: string): string | undefined =>
      code === 'Semicolon' ? 'z' : code === 'KeyZ' ? ';' : undefined
    const optionChord = (code: string) => ({
      key: 'Ω',
      code,
      alt: true,
      control: false,
      meta: false,
      shift: false
    })

    expect(
      keybindingMatchesAction(
        'editor.toggleWordWrap',
        optionChord('Semicolon'),
        'darwin',
        undefined,
        {
          layoutCharacterForCode: dvorak
        }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction('editor.toggleWordWrap', optionChord('KeyZ'), 'darwin', undefined, {
        layoutCharacterForCode: dvorak
      })
    ).toBe(false)
  })
})
