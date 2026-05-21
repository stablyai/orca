import { describe, expect, it, vi } from 'vitest'
import { buildEditableContextMenuTemplate } from './editable-context-menu'
import { richMarkdownContextMenuCommandChannel } from '../../shared/rich-markdown-context-menu'

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
    const send = vi.fn()
    const template = buildEditableContextMenuTemplate(contextParams(), {
      replaceMisspelling,
      send,
      session: { addWordToSpellCheckerDictionary } as unknown as Electron.Session
    })

    expect(template.slice(0, 5).map((item) => item.label ?? item.type)).toEqual([
      'reference',
      'reverence',
      'separator',
      'Add to dictionary',
      'separator'
    ])

    template[0].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[3].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)

    expect(replaceMisspelling).toHaveBeenCalledWith('reference')
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith('refrence')
  })

  it('builds a menu when Chromium reports suggestions even if spellcheckEnabled is false', () => {
    const template = buildEditableContextMenuTemplate(contextParams({ spellcheckEnabled: false }), {
      replaceMisspelling: vi.fn(),
      send: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
    })

    expect(template.map((item) => item.label ?? item.type)).toContain('reference')
  })

  it('adds useful markdown and native edit actions for rich markdown text', () => {
    const send = vi.fn()
    const template = buildEditableContextMenuTemplate(
      contextParams({ x: 12, y: 34, misspelledWord: '', dictionarySuggestions: [] }),
      {
        replaceMisspelling: vi.fn(),
        send,
        session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
      }
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'Add link',
      'separator',
      'Format',
      'Paragraph',
      'Insert',
      'separator',
      'cut',
      'copy',
      'paste',
      'Paste as plain text',
      'selectAll'
    ])

    template[0].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    expect(send).toHaveBeenCalledWith(richMarkdownContextMenuCommandChannel, {
      command: 'add-link',
      x: 12,
      y: 34
    })

    const formatMenu = template[2].submenu as Electron.MenuItemConstructorOptions[]
    formatMenu[0].click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as KeyboardEvent
    )
    expect(send).toHaveBeenLastCalledWith(richMarkdownContextMenuCommandChannel, {
      command: 'bold',
      x: 12,
      y: 34
    })
  })

  it('does not build a menu outside editable misspelled text', () => {
    const webContents = {
      replaceMisspelling: vi.fn(),
      send: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
    }

    expect(
      buildEditableContextMenuTemplate(contextParams({ isEditable: false }), webContents)
    ).toEqual([])
    expect(
      buildEditableContextMenuTemplate(
        contextParams({
          formControlType: 'input-text',
          misspelledWord: '',
          dictionarySuggestions: []
        }),
        webContents
      )
    ).toEqual([])
  })

  it('keeps regular text inputs to spelling and native edit actions', () => {
    const template = buildEditableContextMenuTemplate(
      contextParams({ formControlType: 'input-text' }),
      {
        replaceMisspelling: vi.fn(),
        send: vi.fn(),
        session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
      }
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'reference',
      'reverence',
      'separator',
      'Add to dictionary',
      'separator',
      'cut',
      'copy',
      'paste',
      'Paste as plain text',
      'selectAll'
    ])
  })
})
