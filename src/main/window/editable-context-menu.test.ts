import { describe, expect, it, vi } from 'vitest'
import {
  buildEditableContextMenuTemplate,
  buildRichMarkdownTableTargetExpression,
  isRichMarkdownTableContextTarget
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
      { includeTableActions: true }
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

describe('buildRichMarkdownTableTargetExpression', () => {
  it('queries table cells inside the rich markdown editor at the context point', () => {
    expect(buildRichMarkdownTableTargetExpression(12, 34)).toBe(
      "Boolean(document.elementFromPoint(12, 34)?.closest('.rich-markdown-editor-shell td, .rich-markdown-editor-shell th'))"
    )
  })

  it('replaces non-finite coordinates with offscreen values', () => {
    expect(buildRichMarkdownTableTargetExpression(Number.NaN, Number.POSITIVE_INFINITY)).toContain(
      'elementFromPoint(-1, -1)'
    )
  })
})

describe('isRichMarkdownTableContextTarget', () => {
  it('returns the renderer table-cell result for rich markdown targets', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue(true)

    await expect(
      isRichMarkdownTableContextTarget(contextParams({ x: 12, y: 34 }), {
        executeJavaScript
      })
    ).resolves.toBe(true)
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('elementFromPoint(12, 34)')
    )
  })

  it('skips renderer queries outside rich markdown and fails closed', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('renderer unavailable'))

    await expect(
      isRichMarkdownTableContextTarget(contextParams(), { executeJavaScript })
    ).resolves.toBe(false)
    await expect(
      isRichMarkdownTableContextTarget(contextParams({ formControlType: 'input-text' }), {
        executeJavaScript
      })
    ).resolves.toBe(false)
    expect(executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung renderer query so the native menu can still open', async () => {
    const executeJavaScript = vi.fn(() => new Promise<never>(() => {}))

    await expect(
      isRichMarkdownTableContextTarget(contextParams(), { executeJavaScript }, 1)
    ).resolves.toBe(false)
  })

  it('fails closed when executeJavaScript throws synchronously', async () => {
    const executeJavaScript = vi.fn(() => {
      throw new Error('renderer destroyed')
    })

    await expect(
      isRichMarkdownTableContextTarget(contextParams(), { executeJavaScript })
    ).resolves.toBe(false)
  })
})
