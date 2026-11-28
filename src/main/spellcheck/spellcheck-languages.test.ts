import { describe, expect, it, vi } from 'vitest'
import {
  applySpellcheckLanguages,
  followSpellcheckLanguages,
  MAX_SPELLCHECK_LANGUAGES,
  normalizeSpellcheckLanguages,
  type SpellcheckSession
} from './spellcheck-languages'

function fakeSession(options: {
  available: string[]
  current: string[]
}): SpellcheckSession & { applied: string[][] } {
  let current = [...options.current]
  const applied: string[][] = []
  return {
    availableSpellCheckerLanguages: [...options.available],
    getSpellCheckerLanguages: () => [...current],
    setSpellCheckerLanguages: (languages) => {
      current = [...languages]
      applied.push([...languages])
    },
    applied
  }
}

describe('normalizeSpellcheckLanguages', () => {
  it('trims, drops non-strings and duplicates, and caps the list', () => {
    const input = [
      ' en-US ',
      'en-US',
      '',
      42,
      'fr',
      ...Array.from({ length: MAX_SPELLCHECK_LANGUAGES }, (_, index) => `extra-${index}`)
    ]
    expect(normalizeSpellcheckLanguages(input)).toEqual([
      'en-US',
      'fr',
      ...Array.from({ length: MAX_SPELLCHECK_LANGUAGES - 2 }, (_, index) => `extra-${index}`)
    ])
  })

  it('reads a non-array as the system default', () => {
    expect(normalizeSpellcheckLanguages('en-US')).toEqual([])
    expect(normalizeSpellcheckLanguages(undefined)).toEqual([])
  })
})

describe('applySpellcheckLanguages', () => {
  it('applies only the requested languages the session offers', () => {
    const session = fakeSession({ available: ['en-US', 'fr', 'de'], current: ['en-US'] })
    expect(applySpellcheckLanguages(session, ['fr', 'xx-YY', 'de'], ['en-US'], 'linux')).toEqual([
      'fr',
      'de'
    ])
    expect(session.applied).toEqual([['fr', 'de']])
  })

  it('restores the startup languages when the selection is empty', () => {
    const session = fakeSession({ available: ['en-US', 'fr'], current: ['fr'] })
    expect(applySpellcheckLanguages(session, [], ['en-US'], 'win32')).toEqual(['en-US'])
    expect(session.applied).toEqual([['en-US']])
  })

  it('restores the startup languages when none of the requested ones are available', () => {
    const session = fakeSession({ available: ['en-US'], current: ['en-US'] })
    expect(applySpellcheckLanguages(session, ['xx-YY'], ['en-US'], 'linux')).toEqual(['en-US'])
    expect(session.applied).toEqual([])
  })

  it('does not call the setter when the session already uses the requested languages', () => {
    const session = fakeSession({ available: ['en-US', 'fr'], current: ['fr', 'en-US'] })
    applySpellcheckLanguages(session, ['fr', 'en-US'], ['en-US'], 'win32')
    expect(session.applied).toEqual([])
  })

  it('is a no-op on macOS, where the OS chooses the language', () => {
    const session = fakeSession({ available: ['en-US', 'fr'], current: ['en-US'] })
    applySpellcheckLanguages(session, ['fr'], ['en-US'], 'darwin')
    expect(session.applied).toEqual([])
  })
})

describe('followSpellcheckLanguages', () => {
  it('applies at startup and on later changes, ignoring unrelated updates', () => {
    const session = fakeSession({ available: ['en-US', 'fr', 'de'], current: ['en-US'] })
    const listeners: ((
      updates: { spellcheckLanguages?: readonly string[] },
      settings: { spellcheckLanguages?: readonly string[] }
    ) => void)[] = []
    const settings = { spellcheckLanguages: ['fr'] }
    const unsubscribe = vi.fn()
    followSpellcheckLanguages(
      {
        getSettings: () => settings,
        onSettingsChanged: (next) => {
          listeners.push(next)
          return unsubscribe
        }
      },
      session,
      'linux'
    )
    expect(session.applied).toEqual([['fr']])

    listeners[0]?.({}, { spellcheckLanguages: ['fr'] })
    expect(session.applied).toEqual([['fr']])

    listeners[0]?.({ spellcheckLanguages: ['de'] }, { spellcheckLanguages: ['de'] })
    expect(session.applied).toEqual([['fr'], ['de']])
  })

  it('does nothing on macOS', () => {
    const session = fakeSession({ available: ['en-US'], current: ['en-US'] })
    const onSettingsChanged = vi.fn()
    followSpellcheckLanguages(
      { getSettings: () => ({ spellcheckLanguages: ['fr'] }), onSettingsChanged },
      session,
      'darwin'
    )
    expect(session.applied).toEqual([])
    expect(onSettingsChanged).not.toHaveBeenCalled()
  })
})
