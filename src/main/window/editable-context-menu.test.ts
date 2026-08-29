import { describe, expect, it, vi } from 'vitest'
import {
  buildEditableContextMenuTemplate,
  matchingRichMarkdownContextMenuTableTarget,
  parseRichMarkdownContextMenuTableTarget
} from './editable-context-menu'
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
      },
      { tableTarget: { cellType: 'body', targetId: 'table-target-1', x: 12, y: 34 } }
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'Add link',
      'separator',
      'Format',
      'Paragraph',
      'Insert',
      'Table',
      'separator',
      'cut',
      'copy',
      'Paste',
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

    const paragraphMenu = template[3].submenu as Electron.MenuItemConstructorOptions[]
    expect(paragraphMenu.map((item) => item.label ?? item.type)).toEqual([
      'Body text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'separator',
      'Bullet list',
      'Numbered list',
      'Checklist'
    ])
    paragraphMenu[5].click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as KeyboardEvent
    )
    expect(send).toHaveBeenLastCalledWith(richMarkdownContextMenuCommandChannel, {
      command: 'heading-5',
      x: 12,
      y: 34
    })

    const tableMenu = template[5].submenu as Electron.MenuItemConstructorOptions[]
    expect(tableMenu.map((item) => item.label ?? item.type)).toEqual([
      'Insert row above',
      'Insert row below',
      'Delete row',
      'separator',
      'Insert column left',
      'Insert column right',
      'Delete column',
      'separator',
      'Delete table'
    ])
    tableMenu[0].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    expect(send).toHaveBeenLastCalledWith(richMarkdownContextMenuCommandChannel, {
      command: 'insert-row-above',
      tableTargetId: 'table-target-1',
      x: 12,
      y: 34
    })

    template[9].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[10].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: false })
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: true })
  })

  it('omits table actions when the context target is outside a table', () => {
    const template = buildEditableContextMenuTemplate(
      contextParams({ misspelledWord: '', dictionarySuggestions: [] }),
      {
        replaceMisspelling: vi.fn(),
        send: vi.fn(),
        session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
      }
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).not.toContain('Table')
  })

  it('disables native row actions that cannot cross the Markdown header boundary', () => {
    const template = buildEditableContextMenuTemplate(
      contextParams({ x: 12, y: 34, misspelledWord: '', dictionarySuggestions: [] }),
      {
        replaceMisspelling: vi.fn(),
        send: vi.fn(),
        session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
      },
      { tableTarget: { cellType: 'header', targetId: 'header-target', x: 12, y: 34 } }
    )
    const tableMenu = template[5].submenu as Electron.MenuItemConstructorOptions[]

    expect(tableMenu[0]).toMatchObject({ label: 'Insert row above', enabled: false })
    expect(tableMenu[1]).toMatchObject({ label: 'Insert row below' })
    expect(tableMenu[2]).toMatchObject({ label: 'Delete row', enabled: false })
  })

  it('does not build a menu outside editable text', () => {
    const webContents = {
      replaceMisspelling: vi.fn(),
      send: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
    }

    expect(
      buildEditableContextMenuTemplate(contextParams({ isEditable: false }), webContents)
    ).toEqual([])
  })

  it('keeps coordinated paste available for regular editable text without spelling actions', () => {
    const send = vi.fn()
    const template = buildEditableContextMenuTemplate(
      contextParams({
        formControlType: 'input-text',
        misspelledWord: '',
        dictionarySuggestions: []
      }),
      {
        replaceMisspelling: vi.fn(),
        send,
        session: { addWordToSpellCheckerDictionary: vi.fn() } as unknown as Electron.Session
      }
    )

    expect(template.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'cut',
      'copy',
      'Paste',
      'Paste as plain text',
      'selectAll'
    ])

    template[2].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[3].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: false })
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: true })
  })

  it('keeps regular text inputs to spelling and native edit actions', () => {
    const send = vi.fn()
    const template = buildEditableContextMenuTemplate(
      contextParams({ formControlType: 'input-text' }),
      {
        replaceMisspelling: vi.fn(),
        send,
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
      'Paste',
      'Paste as plain text',
      'selectAll'
    ])

    template[7].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    template[8].click?.({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent)
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: false })
    expect(send).toHaveBeenCalledWith('ui:editableContextPaste', { plainTextOnly: true })
  })
})

describe('rich markdown context-menu table targets', () => {
  const target = { cellType: 'body' as const, targetId: 'table-target', x: 12, y: 34 }

  it('accepts a valid renderer-reported table target', () => {
    expect(parseRichMarkdownContextMenuTableTarget(target)).toEqual(target)
    expect(
      matchingRichMarkdownContextMenuTableTarget(contextParams({ x: 12, y: 34 }), target)
    ).toEqual(target)
  })

  it('rejects malformed, stale, and non-rich targets', () => {
    expect(parseRichMarkdownContextMenuTableTarget({ ...target, x: Number.NaN })).toBeNull()
    expect(parseRichMarkdownContextMenuTableTarget({ ...target, cellType: 'footer' })).toBeNull()
    expect(
      matchingRichMarkdownContextMenuTableTarget(contextParams({ x: 13, y: 34 }), target)
    ).toBeNull()
    expect(
      matchingRichMarkdownContextMenuTableTarget(
        contextParams({ x: 12, y: 34, formControlType: 'input-text' }),
        target
      )
    ).toBeNull()
  })
})
