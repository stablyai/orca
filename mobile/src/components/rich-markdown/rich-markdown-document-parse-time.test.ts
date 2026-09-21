import { describe, expect, it } from 'vitest'
import {
  documentModuleNames,
  documentModuleSource,
  exportedLifecycleFunctions,
  moduleLevelMutableBindings,
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

  it('would report work in every declaration that runs as the module is evaluated', () => {
    // Three shapes, because a reader that knew only the first would accept the other two and the
    // empty list above would be about nothing. A statement-kind filter waves all three through:
    // each is a declaration by shape and parse-time work by effect.
    const planted: [string, string, string][] = [
      [
        'a const read from the document',
        "const editor = document.getElementById('editor')\n",
        "planted: editor = document.getElementById('editor')"
      ],
      [
        'a static class member',
        'class Reporter {\n  static installed = install()\n}\n',
        'planted: static installed = install()'
      ],
      ['a default export that is an expression', 'export default install()\n', 'planted: install()']
    ]
    expect(
      planted.map(([written, source]) => [written, parseTimeEffects('planted', source)])
    ).toEqual(planted.map(([written, , named]) => [written, [named]]))
  })

  it('leaves declarations that only declare alone, so the empty list is a measurement', () => {
    // The other direction, and the two that look like the shapes above but are not: an instance
    // field runs per `new`, and nothing in a document is ever constructed at parse; a default
    // export of a function declares a body that runs when something calls it.
    const inert = [
      'const options = { capture: true, passive: false }\n',
      'class Reporter {\n  pending = install()\n}\n',
      'export default function () {\n  return install()\n}\n'
    ]
    expect(inert.map((source) => parseTimeEffects('inert', source))).toEqual([[], [], []])
  })

  it('holds no mutable binding of its own: every one is a field of the scope', () => {
    // Ruling 21. The factory gives each call its own scope, so a `let` in a module would be the one
    // thing two editors on one page still shared — the second mount would inherit the first's
    // generation, its remembered caret and its last reported inset.
    expect(MODULES.flatMap((name) => moduleLevelMutableBindings(name, moduleSource(name)))).toEqual(
      []
    )
  })

  it('would name one in every shape a module can write it', () => {
    // The precondition, and it is per shape rather than one sample: a line match would have caught
    // only the first of these four, and the other three are the same shared binding.
    const planted: [string, string, string][] = [
      ['bare', 'let pending = null\n', 'planted: let pending'],
      ['var', 'var pending = null\n', 'planted: var pending'],
      ['exported', 'export let pending = null\n', 'planted: let pending'],
      ['in a block', 'if (true) {\n  let pending = null\n}\n', 'planted: let pending'],
      [
        'in a loop head',
        'for (let pending = 0; pending < 1; pending++) {\n}\n',
        'planted: let pending'
      ]
    ]
    expect(
      planted.map(([syntax, source]) => [syntax, moduleLevelMutableBindings('planted', source)])
    ).toEqual(planted.map(([syntax, , named]) => [syntax, [named]]))
  })

  it('leaves a const and a function-local let alone, so the empty list is a measurement', () => {
    // The other direction: a reader that refused every declaration would agree with the empty
    // expectation just as happily. A binding one call owns is not module state.
    const inert =
      'const options = { capture: true }\n' +
      'export function n() {\n  let index = 0\n  for (var step = 0; step < 2; step++) {\n' +
      '    index += step\n  }\n  return index + (options.capture ? 1 : 0)\n}\n'
    expect(moduleLevelMutableBindings('inert', inert)).toEqual([])
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

  it('finds a lifecycle export however it is written, and only when it is one', () => {
    // The precondition for the comparison above, and the reason it is read from the tree: a
    // pattern over the source needed one exact spelling, so `async`, a return type or a parameter
    // list the formatter wrapped made a real start disappear — and a start missing from both
    // lists makes them agree, which is the silent version of the failure they exist to catch.
    const spellings: [string, string][] = [
      ['plain', 'export function startKeyboardInset(scope: RichMarkdownEditorScope) {\n}\n'],
      ['async', 'export async function startKeyboardInset(scope: RichMarkdownEditorScope) {\n}\n'],
      [
        'with a return type',
        'export function startKeyboardInset(scope: RichMarkdownEditorScope): void {\n}\n'
      ],
      [
        'wrapped parameters',
        'export function startKeyboardInset(\n  scope: RichMarkdownEditorScope\n) {\n}\n'
      ]
    ]
    expect(
      spellings.map(([spelling, source]) => [
        spelling,
        exportedLifecycleFunctions(source, 'start', 'RichMarkdownEditorScope')
      ])
    ).toEqual(spellings.map(([spelling]) => [spelling, ['startKeyboardInset']]))

    // And only when it is one. A start that takes more than the scope is an act the document
    // performs, not a module's lifecycle (ruling 20), and a start over another document's scope
    // belongs to that document.
    const refused = [
      'export function startEdgeScroll(scope: RichMarkdownEditorScope, dir: number) {\n}\n',
      'export function startTapDispatch(scope: TerminalDocumentScope) {\n}\n',
      'function startKeyboardInset(scope: RichMarkdownEditorScope) {\n}\n'
    ]
    expect(
      refused.map((source) =>
        exportedLifecycleFunctions(source, 'start', 'RichMarkdownEditorScope')
      )
    ).toEqual([[], [], []])
  })

  it('would name a start the sequence forgot, which is what the comparison above is for', () => {
    const planted = sequenceCallsTo('startRichMarkdownEditorDocument')
    expect(planted).not.toContain('startEditorCommands')
    expect([...planted, 'startEditorCommands'].sort()).not.toEqual(planted.slice().sort())
  })
})
