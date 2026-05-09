import { describe, expect, it, vi } from 'vitest'
import { buildEditableContextMenuTemplate } from './editable-context-menu'

function contextParams(
  overrides: Partial<Electron.ContextMenuParams> = {}
): Electron.ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: '',
    linkText: '',
    pageURL: '',
    frameURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: true,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: {} as Electron.Referrer,
    misspelledWord: 'refrence',
    dictionarySuggestions: ['reference', 'reverence'],
    frameCharset: 'utf-8',
    formControlType: 'none',
    spellcheckEnabled: true,
    menuSourceType: 'mouse',
    mediaFlags: {} as Electron.MediaFlags,
    editFlags: {} as Electron.EditFlags,
    ...overrides
  }
}

describe('buildEditableContextMenuTemplate', () => {
  it('builds spelling suggestion actions for editable markdown text', () => {
    const replaceMisspelling = vi.fn()
    const addWordToSpellCheckerDictionary = vi.fn()
    const template = buildEditableContextMenuTemplate(contextParams(), {
      replaceMisspelling,
      session: { addWordToSpellCheckerDictionary } as unknown as Electron.Session
    })

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'reference',
      'reverence',
      'separator',
      'Add to dictionary'
    ])

    template[0].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[3].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)

    expect(replaceMisspelling).toHaveBeenCalledWith('reference')
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith('refrence')
  })

  it('does not build a menu outside editable spellchecked text', () => {
    const webContents = {
      replaceMisspelling: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
    }

    expect(
      buildEditableContextMenuTemplate(contextParams({ isEditable: false }), webContents)
    ).toEqual([])
    expect(
      buildEditableContextMenuTemplate(contextParams({ spellcheckEnabled: false }), webContents)
    ).toEqual([])
    expect(
      buildEditableContextMenuTemplate(
        contextParams({ misspelledWord: '', dictionarySuggestions: [] }),
        webContents
      )
    ).toEqual([])
  })
})
