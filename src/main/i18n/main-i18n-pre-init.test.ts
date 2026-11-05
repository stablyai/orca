import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') }
}))

describe('translateMain before init', () => {
  it('fills fallback placeholders and leaves unknown ones as written', async () => {
    const { translateMain } = await import('./main-i18n')
    expect(
      translateMain('profileState.copyChoice.lastSaved', 'Last saved {{time}}.', { time: 'now' })
    ).toBe('Last saved now.')
    expect(translateMain('missing.key', 'Keeps {{unknown}} as is.', {})).toBe(
      'Keeps {{unknown}} as is.'
    )
  })
})
