import { describe, expect, it } from 'vitest'
import {
  buildMobileRichMarkdownEditorHtml,
  escapeInjectedJavaScriptString
} from './mobile-rich-markdown-editor-html'

function editorScript(): string {
  const html = buildMobileRichMarkdownEditorHtml()
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  expect(script).toBeTruthy()
  return script ?? ''
}

function extractBracedSource(script: string, start: number, label: string): string {
  const bodyStart = script.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < script.length; index += 1) {
    const char = script[index]
    if (char === '{') {
      depth += 1
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return script.slice(start, index + 1)
      }
    }
  }
  throw new Error(`Could not extract ${label}`)
}

function extractFunctionSource(script: string, name: string): string {
  const start = script.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  return extractBracedSource(script, start, name)
}

function extractEditorListenerSource(script: string, type: string): string {
  const start = script.indexOf(`editor.addEventListener('${type}'`)
  expect(start).toBeGreaterThanOrEqual(0)
  return `${extractBracedSource(script, start, `${type} listener`)});`
}

function runtimeMarkdownToHtml(markdown: string, editable: boolean): string {
  const script = editorScript()
  const sources = [
    'var editable = arguments[1];',
    extractFunctionSource(script, 'decodeMarkdownEntities'),
    extractFunctionSource(script, 'escapeHtml'),
    extractFunctionSource(script, 'escapeAttr'),
    extractFunctionSource(script, 'isSafeUrl'),
    extractFunctionSource(script, 'splitTableRow'),
    extractFunctionSource(script, 'isTableSeparator'),
    extractFunctionSource(script, 'renderInline'),
    extractFunctionSource(script, 'isBlockStart'),
    extractFunctionSource(script, 'indentationWidth'),
    extractFunctionSource(script, 'parseListLine'),
    extractFunctionSource(script, 'listKind'),
    extractFunctionSource(script, 'parseListTree'),
    extractFunctionSource(script, 'renderListItems'),
    extractFunctionSource(script, 'markdownToHtml'),
    'return markdownToHtml(arguments[0]);'
  ].join('\n')
  return new Function(sources)(markdown, editable) as string
}

function runtimeListMarkdown(): (list: unknown) => string {
  const script = editorScript()
  const sources = [
    'function listItemText(li) { return li.text; }',
    'function directNestedLists(li) { return li.nestedLists || []; }',
    extractFunctionSource(script, 'listMarkdown'),
    'return function (list) { return listMarkdown(list, 0); };'
  ].join('\n')
  return new Function(sources)() as (list: unknown) => string
}

type FakeRange = {
  commonAncestorContainer: unknown
  cloneRange: () => FakeRange
  selectNodeContents: (node: unknown) => void
  collapse: (toStart: boolean) => void
}

function createFakeRange(container: unknown): FakeRange {
  const range: FakeRange = {
    commonAncestorContainer: container,
    cloneRange: () => createFakeRange(range.commonAncestorContainer),
    selectNodeContents: (node) => {
      range.commonAncestorContainer = node
    },
    collapse: () => {}
  }
  return range
}

type FakeClickEvent = {
  clientX: number
  clientY: number
  target: { closest: (selector: string) => unknown }
  preventDefault: () => void
}

// Drives the editor's real selection and click handling against a stub DOM whose blur
// drops the selection, the way WebKit does.
function createSelectionRuntime(caretContainer: string | null) {
  const liveNodes = new Set(caretContainer ? [caretContainer] : [])
  const listeners = new Map<string, (event: FakeClickEvent) => void>()
  let focused = caretContainer != null
  let ranges: FakeRange[] = caretContainer ? [createFakeRange(caretContainer)] : []
  let caretAtPoint: string | null = null

  const editor = {
    contains: (node: unknown) => typeof node === 'string' && liveNodes.has(node),
    focus: () => {
      focused = true
      fakeDocument.activeElement = editor
    },
    blur: () => {
      focused = false
      fakeDocument.activeElement = null
      ranges = []
    },
    addEventListener: (type: string, handler: (event: FakeClickEvent) => void) => {
      listeners.set(type, handler)
    }
  }
  const fakeDocument: {
    activeElement: unknown
    createRange: () => FakeRange
    caretRangeFromPoint: () => FakeRange | null
  } = {
    activeElement: focused ? editor : null,
    createRange: () => createFakeRange('detached'),
    caretRangeFromPoint: () => (caretAtPoint ? createFakeRange(caretAtPoint) : null)
  }
  const fakeWindow = {
    getSelection: () => ({
      get rangeCount() {
        return ranges.length
      },
      getRangeAt: (index: number) => ranges[index],
      removeAllRanges: () => {
        ranges = []
      },
      addRange: (range: FakeRange) => {
        ranges = [range]
      }
    })
  }

  const script = editorScript()
  const sources = [
    'var editor = arguments[0];',
    'var document = arguments[1];',
    'var window = arguments[2];',
    'var editable = true;',
    'var savedSelectionRange = null;',
    'var selectionDroppedOnBlur = false;',
    'function post() {}',
    'function emitChange() {}',
    extractFunctionSource(script, 'focusEditor'),
    extractFunctionSource(script, 'rememberSelection'),
    extractFunctionSource(script, 'applySelectionRange'),
    extractFunctionSource(script, 'caretRangeAtPoint'),
    extractFunctionSource(script, 'dismissKeyboard'),
    extractFunctionSource(script, 'restoreSelectionOrEnd'),
    extractEditorListenerSource(script, 'click'),
    'return { dismissKeyboard: dismissKeyboard, restoreSelectionOrEnd: restoreSelectionOrEnd };'
  ].join('\n')
  const api = new Function(sources)(editor, fakeDocument, fakeWindow) as {
    dismissKeyboard: () => void
    restoreSelectionOrEnd: () => void
  }

  return {
    dismissKeyboard: api.dismissKeyboard,
    restoreSelectionOrEnd: api.restoreSelectionOrEnd,
    tapAt: (container: string, options?: { uneditableAncestor?: string }) => {
      liveNodes.add(container)
      caretAtPoint = container
      listeners.get('click')?.({
        clientX: 12,
        clientY: 34,
        target: {
          closest: (selector: string) =>
            selector === '[contenteditable="false"]' ? (options?.uneditableAncestor ?? null) : null
        },
        preventDefault: () => {}
      })
    },
    detachEditorContent: () => liveNodes.clear(),
    selectedContainer: () => {
      if (ranges.length === 0) {
        return null
      }
      const container = ranges[0].commonAncestorContainer
      return container === editor ? 'editor-end' : (container as string)
    },
    get focused() {
      return focused
    }
  }
}

describe('mobile rich markdown editor HTML', () => {
  it('builds parseable WebView JavaScript', () => {
    const script = editorScript()

    expect(() => new Function(script)).not.toThrow()
  })

  it('escapes injected markdown without reopening script tags', () => {
    const escaped = escapeInjectedJavaScriptString('</script><script>alert(1)</script>')

    expect(escaped).not.toContain('</script>')
    expect(JSON.parse(escaped.replace(/<\\\/script/gi, '</script'))).toBe(
      '</script><script>alert(1)</script>'
    )
  })

  it('renders and serializes nested bullet, ordered, and task lists with indentation intact', () => {
    const markdown = [
      '- Parent',
      '  1. Ordered child',
      '    - [x] Done task',
      '    - [ ] Open task',
      '- Sibling'
    ].join('\n')

    const html = runtimeMarkdownToHtml(markdown, true)

    expect(html).toContain(
      '<ul><li><p>Parent</p><ol start="1"><li value="1" data-list-number="1"><p>Ordered child</p>'
    )
    expect(html).toContain('<ul data-type="taskList">')
    expect(html).toContain('<li><p>Sibling</p></li></ul>')

    const listMarkdown = runtimeListMarkdown()
    const fakeList = {
      tagName: 'UL',
      getAttribute: () => null,
      children: [
        {
          tagName: 'LI',
          text: 'Parent',
          querySelector: () => null,
          nestedLists: [
            {
              tagName: 'OL',
              getAttribute: () => null,
              children: [
                {
                  tagName: 'LI',
                  text: 'Ordered child',
                  querySelector: () => null,
                  nestedLists: [
                    {
                      tagName: 'UL',
                      getAttribute: (name: string) => (name === 'data-type' ? 'taskList' : null),
                      children: [
                        {
                          tagName: 'LI',
                          text: 'Done task',
                          querySelector: () => ({ checked: true }),
                          nestedLists: []
                        },
                        {
                          tagName: 'LI',
                          text: 'Open task',
                          querySelector: () => ({ checked: false }),
                          nestedLists: []
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        { tagName: 'LI', text: 'Sibling', querySelector: () => null, nestedLists: [] }
      ]
    }

    expect(listMarkdown(fakeList)).toBe(markdown)
  })

  it('renders markdown entities as characters without double-escaping them', () => {
    const html = runtimeMarkdownToHtml('R&D &amp; Sales and &lt;tag&gt;', true)

    expect(html).toContain('R&amp;D &amp; Sales and &lt;tag&gt;')
    expect(html).not.toContain('&amp;amp;')
  })

  it('preserves explicit ordered-list numbering during serialization', () => {
    const markdown = ['3. Third step', '4. Fourth step'].join('\n')
    const html = runtimeMarkdownToHtml(markdown, true)

    expect(html).toContain('<ol start="3">')
    expect(html).toContain('data-list-number="3"')

    const listMarkdown = runtimeListMarkdown()
    const fakeList = {
      tagName: 'OL',
      getAttribute: () => null,
      children: [
        {
          tagName: 'LI',
          text: 'Third step',
          getAttribute: (name: string) => (name === 'data-list-number' ? '3' : null),
          querySelector: () => null,
          nestedLists: []
        },
        {
          tagName: 'LI',
          text: 'Fourth step',
          getAttribute: (name: string) => (name === 'data-list-number' ? '4' : null),
          querySelector: () => null,
          nestedLists: []
        }
      ]
    }

    expect(listMarkdown(fakeList)).toBe(markdown)
  })

  it('serializes ordered lists from parent start when item metadata is missing', () => {
    const listMarkdown = runtimeListMarkdown()
    const fakeList = {
      tagName: 'OL',
      getAttribute: (name: string) => (name === 'start' ? '8' : null),
      children: [
        {
          tagName: 'LI',
          text: 'Pasted step',
          getAttribute: () => null,
          querySelector: () => null,
          nestedLists: []
        },
        {
          tagName: 'LI',
          text: 'Inserted step',
          getAttribute: () => null,
          querySelector: () => null,
          nestedLists: []
        }
      ]
    }

    expect(listMarkdown(fakeList)).toBe(['8. Pasted step', '9. Inserted step'].join('\n'))
  })

  it('renders task checkboxes as disabled while read-only and guards mutation emitters', () => {
    const html = runtimeMarkdownToHtml('- [ ] Read-only task', false)
    const script = editorScript()

    expect(html).toContain('type="checkbox" disabled')
    expect(extractFunctionSource(script, 'emitChange')).toContain('suppressInput || !editable')
    expect(extractFunctionSource(script, 'setEditable')).toContain('syncTaskCheckboxesDisabled')
  })

  it('carries document generations through content replacement and change messages', () => {
    const script = editorScript()
    const setMarkdown = extractFunctionSource(script, 'setMarkdown')
    const emitChange = extractFunctionSource(script, 'emitChange')

    expect(setMarkdown).toContain('window.clearTimeout(inputTimer)')
    expect(setMarkdown).toContain('documentGeneration = Number(generation) || 0')
    expect(emitChange).toContain('var pendingGeneration = documentGeneration')
    expect(emitChange).not.toContain('window.setTimeout')
    expect(emitChange).toContain('generation: pendingGeneration')
  })

  it('exposes a keyboard dismissal command that blurs WebView focus', () => {
    const script = editorScript()
    const dismissKeyboard = extractFunctionSource(script, 'dismissKeyboard')

    expect(dismissKeyboard).toContain('rememberSelection()')
    expect(dismissKeyboard).toContain('document.activeElement.blur()')
    expect(dismissKeyboard).toContain('editor.blur()')
    expect(script).toContain('dismissKeyboard: dismissKeyboard')
  })

  it('reclaims editor focus at the tapped caret after keyboard dismissal', () => {
    const runtime = createSelectionRuntime('paragraph-3')

    runtime.dismissKeyboard()
    runtime.tapAt('paragraph-7')

    expect(runtime.focused).toBe(true)
    expect(runtime.selectedContainer()).toBe('paragraph-7')
  })

  it('leaves task-list label taps to the checkbox instead of refocusing the editor', () => {
    const runtime = createSelectionRuntime('paragraph-3')

    runtime.dismissKeyboard()
    runtime.tapAt('paragraph-7', { uneditableAncestor: 'task-label' })

    expect(runtime.focused).toBe(false)
    expect(runtime.selectedContainer()).toBe(null)
  })

  it('restores the pre-dismissal caret so commands do not insert at the document end', () => {
    const runtime = createSelectionRuntime('paragraph-3')

    runtime.dismissKeyboard()
    expect(runtime.selectedContainer()).toBe(null)

    runtime.restoreSelectionOrEnd()

    expect(runtime.selectedContainer()).toBe('paragraph-3')
    expect(runtime.focused).toBe(true)
  })

  it('falls back to the document end when no caret was ever placed', () => {
    const runtime = createSelectionRuntime(null)

    runtime.restoreSelectionOrEnd()

    expect(runtime.selectedContainer()).toBe('editor-end')
  })

  it('drops a remembered caret whose nodes left the document', () => {
    const runtime = createSelectionRuntime('paragraph-3')

    runtime.dismissKeyboard()
    runtime.detachEditorContent()
    runtime.restoreSelectionOrEnd()

    expect(runtime.selectedContainer()).toBe('editor-end')
  })
})
