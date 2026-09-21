import { describe, expect, it } from 'vitest'
import {
  documentModuleNames,
  documentModuleSource,
  exportedLifecycleFunctions,
  parseTimeEffects,
  sequenceCalls,
  topLevelDeclarationsReachAnElement
} from '../../test-support/webview-document-census'

/**
 * Rulings 20 and 21 over the editor's document, checked by the readers the terminal's census uses.
 *
 * The hand-written script could read `#editor` and install its listeners as it was parsed, because
 * the WebView re-parses the whole document on every load. These modules are imported, and an ES
 * module body runs once per page: a read or a listener left at a module's top level would hand the
 * page's second mount the first mount's element and install nothing, which is a dead editor that
 * reports itself ready.
 *
 * So every effect lives in a start function both hosts call, and every mutable binding lives on
 * the scope rather than in a module, which is what makes two editors on one page two editors.
 */
const DIRECTORY = import.meta.dirname

/** The entry is the one file allowed a statement at its top level — it is the call. */
const ENTRY = 'native-document-entry'

/** The sequence that calls the starts, which is not a module with a start of its own. */
const THE_SEQUENCE = 'create-rich-markdown-editor-document'

const MODULES = documentModuleNames(DIRECTORY, [ENTRY])

const moduleSource = (name: string) => documentModuleSource(DIRECTORY, name)

const sequenceCallsTo = (functionName: string) =>
  sequenceCalls(moduleSource(THE_SEQUENCE), functionName, [
    'startRichMarkdownEditorDocument',
    'stopRichMarkdownEditorDocument'
  ])

describe('the rich Markdown editor document at parse time', () => {
  it('does no work: every effect is in a start function the hosts call', () => {
    expect(MODULES.length).toBeGreaterThan(15)
    expect(MODULES.flatMap((name) => parseTimeEffects(name, moduleSource(name)))).toEqual([])
  })

  it('declares nothing that reaches an element', () => {
    for (const name of MODULES) {
      expect({
        name,
        reaches: topLevelDeclarationsReachAnElement(name, moduleSource(name))
      }).toEqual({ name, reaches: false })
    }
  })

  it('holds no mutable binding of its own: every one is a field of the scope', () => {
    // Ruling 21. The factory gives each call its own scope, so a `let` in a module would be the one
    // thing two editors on one page still shared — the second mount would inherit the first's
    // generation, its remembered caret and its last reported inset.
    const declarations = MODULES.flatMap((name) =>
      [...moduleSource(name).matchAll(/^(let|var) /gm)].map((match) => `${name}: ${match[1]}`)
    )
    expect(declarations).toEqual([])
    // The precondition: the reader does find one when there is one.
    expect([...'let inputTimer = null\n'.matchAll(/^(let|var) /gm)]).toHaveLength(1)
  })

  it('starts every module there is, and undoes in reverse the ones that can be undone', () => {
    const exported = (keyword: 'start' | 'stop') =>
      MODULES.filter((name) => name !== THE_SEQUENCE).flatMap((name) =>
        exportedLifecycleFunctions(moduleSource(name), keyword, 'RichMarkdownEditorScope')
      )
    const started = sequenceCallsTo('startRichMarkdownEditorDocument')
    const stopped = sequenceCallsTo('stopRichMarkdownEditorDocument')
    expect([...started].sort()).toEqual(exported('start').sort())
    expect([...stopped].sort()).toEqual(exported('stop').sort())

    // The surface is read before anything reaches for it, and the host is told last, after the
    // inset the host lifts its bar by has been measured.
    expect(started[0]).toBe('startEditorSurface')
    expect(started.at(-1)).toBe('startHostBridge')

    const paired = started.filter((name) => stopped.includes(name.replace(/^start/, 'stop')))
    expect(paired.map((name) => name.replace(/^start/, 'stop'))).toEqual(
      stopped.filter((name) => paired.includes(name.replace(/^stop/, 'start'))).toReversed()
    )
  })

  it('would name a start the sequence forgot, which is what the comparison above is for', () => {
    const planted = sequenceCallsTo('startRichMarkdownEditorDocument')
    expect(planted).not.toContain('startEditorCommands')
    expect([...planted, 'startEditorCommands'].sort()).not.toEqual(planted.slice().sort())
  })
})
