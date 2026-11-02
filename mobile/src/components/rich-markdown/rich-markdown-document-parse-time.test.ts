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

// Require per-start effects and per-scope mutation (rulings 20/21): module parse happens once, so top-level reads/listeners leave second mount bound to first editor.
const DIRECTORY = import.meta.dirname

/** The sequence that calls the starts, which is not a module with a start of its own. */
const THE_SEQUENCE = 'create-rich-markdown-editor-document'

const MODULES = documentModuleNames(DIRECTORY, [])

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
    // Cover three declaration-shaped parse-time effects; statement-kind filter alone incorrectly permits all.
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
    // Allow per-instance fields and exported function bodies: neither executes at module parse.
    const inert = [
      'const options = { capture: true, passive: false }\n',
      'class Reporter {\n  pending = install()\n}\n',
      'export default function () {\n  return install()\n}\n'
    ]
    expect(inert.map((source) => parseTimeEffects('inert', source))).toEqual([[], [], []])
  })

  it('holds no mutable binding of its own: every one is a field of the scope', () => {
    // Module let leaks generation/caret/inset across editor factory calls; each call must own scope (ruling 21).
    expect(MODULES.flatMap((name) => moduleLevelMutableBindings(name, moduleSource(name)))).toEqual(
      []
    )
  })

  it('would name one in every shape a module can write it', () => {
    // Test all four binding forms; line pattern catching one cannot prove module state scan.
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
    // Allow call-local bindings so scanner rejecting every declaration cannot satisfy empty module-state result.
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

    // Read surface first; announce ready after measuring inset so synchronous host reply sees complete setup.
    expect(started[0]).toBe('startEditorSurface')
    expect(started.at(-1)).toBe('startHostBridge')

    const paired = started.filter((name) => stopped.includes(name.replace(/^start/, 'stop')))
    expect(paired.map((name) => name.replace(/^start/, 'stop'))).toEqual(
      stopped.filter((name) => paired.includes(name.replace(/^stop/, 'start'))).toReversed()
    )
  })

  it('finds a lifecycle export however it is written, and only when it is one', () => {
    // Discover starts from AST: async/types/wrapped params must not hide real start from both compared lists and yield vacuous agreement.
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

    // Only own-scope unary start is module lifecycle; extra-arg actions/other-document starts are not (ruling 20).
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
})
