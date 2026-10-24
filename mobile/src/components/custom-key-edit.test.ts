import { describe, expect, it } from 'vitest'
import {
  buildTerminalShortcutKey,
  type TerminalShortcutModifier
} from '../terminal/terminal-accessory-keys'
import {
  customKeyEditDraft,
  customKeyModalTitle,
  customKeySaveLabel,
  replaceCustomKeyPreservingId,
  type CustomKeyFields
} from './custom-key-edit'

function storedShortcut(
  key: string,
  modifiers: TerminalShortcutModifier[],
  id = 'custom-shortcut'
): CustomKeyFields {
  const built = buildTerminalShortcutKey({ key, modifiers })
  if (!built) {
    throw new Error(`could not build ${modifiers.join('+')}+${key}`)
  }
  return { id, label: built.label, bytes: built.bytes, enter: false }
}

describe('customKeyEditDraft', () => {
  it('starts a new key on the type picker', () => {
    expect(customKeyEditDraft(null)).toMatchObject({
      step: 'choose-type',
      shortcutKey: 'c',
      shortcutModifiers: ['ctrl'],
      macroLabel: '',
      macroText: '',
      macroEnter: true
    })
  })

  it('round-trips shortcut combos, including ones whose bytes look like Enter', () => {
    const samples: { key: string; modifiers: TerminalShortcutModifier[] }[] = [
      { key: 'c', modifiers: ['ctrl'] },
      { key: 'm', modifiers: ['ctrl'] },
      { key: 'arrowUp', modifiers: ['ctrl', 'alt'] },
      { key: 'enter', modifiers: [] },
      { key: 'space', modifiers: [] },
      { key: 'f1', modifiers: ['shift'] },
      { key: 'tab', modifiers: ['shift'] },
      { key: 'escape', modifiers: ['alt'] },
      { key: '1', modifiers: ['shift'] },
      { key: 'c', modifiers: ['ctrl', 'alt', 'shift'] }
    ]
    for (const sample of samples) {
      const draft = customKeyEditDraft(storedShortcut(sample.key, sample.modifiers))
      expect(draft.step).toBe('shortcut-combo')
      expect(draft.shortcutKey).toBe(sample.key)
      expect(draft.shortcutModifiers).toEqual(sample.modifiers)
    }
  })

  it('fills a text macro and strips one trailing carriage return', () => {
    expect(
      customKeyEditDraft({
        id: 'custom-build',
        label: 'Build',
        bytes: 'pnpm build\r',
        enter: false
      })
    ).toMatchObject({
      step: 'text-macro',
      macroLabel: 'Build',
      macroText: 'pnpm build',
      macroEnter: true
    })
    expect(
      customKeyEditDraft({ id: 'custom-build', label: 'Build', bytes: 'pnpm build', enter: false })
    ).toMatchObject({ macroText: 'pnpm build', macroEnter: false })
    expect(
      customKeyEditDraft({ id: 'custom-build', label: 'Build', bytes: 'pnpm build', enter: true })
    ).toMatchObject({ macroEnter: true })
  })

  it('keeps printable commands as macros even when the label looks like a chord', () => {
    const draft = customKeyEditDraft({
      id: 'custom-echo',
      label: 'Ctrl+C',
      bytes: 'echo hi\r',
      enter: false
    })
    expect(draft.step).toBe('text-macro')
    expect(draft.macroText).toBe('echo hi')
    expect(draft.macroEnter).toBe(true)
  })

  it('recovers an escape sequence when the label is not a chord', () => {
    const arrow = storedShortcut('arrowUp', [])
    const draft = customKeyEditDraft({ ...arrow, label: 'Nope' })
    expect(draft.step).toBe('shortcut-combo')
    expect(draft.shortcutKey).toBe('arrowUp')
    expect(draft.shortcutModifiers).toEqual([])
  })
})

describe('custom key edit chrome', () => {
  it('uses the edit title and save label only while editing', () => {
    expect(customKeyModalTitle('choose-type', false)).toBe('Add Shortcut')
    expect(customKeyModalTitle('shortcut-combo', false)).toBe('Shortcut Combo')
    expect(customKeyModalTitle('text-macro', false)).toBe('Text Macro')
    expect(customKeyModalTitle('text-macro', true)).toBe('Edit Shortcut')
    expect(customKeySaveLabel(false, 'combo')).toBe('Add')
    expect(customKeySaveLabel(false, 'macro')).toBe('Add Shortcut')
    expect(customKeySaveLabel(true, 'combo')).toBe('Save Changes')
    expect(customKeySaveLabel(true, 'macro')).toBe('Save Changes')
  })
})

describe('replaceCustomKeyPreservingId', () => {
  it('replaces the matching id without moving neighbors', () => {
    const existing = [
      { id: 'custom-a', label: 'A' },
      { id: 'custom-b', label: 'B' },
      { id: 'custom-c', label: 'C' }
    ]
    expect(replaceCustomKeyPreservingId(existing, { id: 'custom-b', label: 'B2' })).toEqual([
      { id: 'custom-a', label: 'A' },
      { id: 'custom-b', label: 'B2' },
      { id: 'custom-c', label: 'C' }
    ])
  })

  it('appends with the same id when the key is no longer in the list', () => {
    expect(replaceCustomKeyPreservingId([{ id: 'custom-a' }], { id: 'custom-b' })).toEqual([
      { id: 'custom-a' },
      { id: 'custom-b' }
    ])
  })
})
