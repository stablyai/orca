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
 * Rulings 20 and 21: no module in the document does work as it is parsed, and none owns state.
 *
 * ES module bodies run once per page. Inside the WebView that was invisible — the script is
 * parsed once per document and the document is the page — but the web component mounts these same
 * modules, and a second mount re-imports nothing. An element read, a listener, or a reporter
 * install left in a module body would therefore keep the *first* mount's elements forever: that is
 * the defect round 1 measured, with zero `.xterm` nodes in the live DOM after a remount.
 *
 * So the rule is structural rather than behavioural, and it is checked structurally. Every
 * emitted module may declare; none may run. What used to run lives in that module's start
 * function, which both hosts call — the bundle once at the foot of the document, the page once per
 * mount. The readers are shared with the rich Markdown editor's document, which is the same rule
 * over a second set of modules.
 *
 * Ruling 21's half of this — no module-level `let`, because a second mount inherited a spent error
 * budget and the first terminal's momentum loop — is not checked any more, and ruling 22 is why. A
 * module's top level is emitted inside the factory, so a `let` there is one binding per call and
 * per document, which is what the scope was being used to achieve. An effect is still refused: it
 * would run at the position its module is emitted rather than in the start sequence, so no stop
 * would undo it and every call would leak another one.
 */
const DIRECTORY = import.meta.dirname

/** The entry is the one file allowed a statement at its top level — it is the call. */
const ENTRY = 'native-document-entry'

/** The sequence that calls the starts, which is not a module with a start of its own. */
const THE_SEQUENCE = 'create-terminal-document'

const MODULES = documentModuleNames(DIRECTORY, [ENTRY])

const moduleSource = (name: string) => documentModuleSource(DIRECTORY, name)

const sequenceCallsTo = (functionName: string) =>
  sequenceCalls(moduleSource(THE_SEQUENCE), functionName, [
    'startTerminalDocument',
    'stopTerminalDocument'
  ])

describe('the document modules at parse time', () => {
  it('do no work: every effect is in a start function the hosts call', () => {
    // Every module, with no exception left: the scope is built by a call now, and the constants the
    // modules own are declarations rather than the substituted literals a generator wrote.
    expect(MODULES.length).toBeGreaterThan(30)
    expect(MODULES.flatMap((name) => parseTimeEffects(name, moduleSource(name)))).toEqual([])
  })

  it('declare nothing that reaches an element', () => {
    // The stricter half, and the one the remount defect was: a declaration whose initialiser reads
    // an element is work by effect whatever its shape, so the same reader runs over every module.
    for (const name of MODULES) {
      expect({
        name,
        reaches: topLevelDeclarationsReachAnElement(name, moduleSource(name))
      }).toEqual({ name, reaches: false })
    }
  })

  it('start and stop: the sequence calls every one there is, and undoes them in reverse', () => {
    // Moving an effect out is only correct if something calls it, and a count cannot say that: a
    // module could export a start nobody runs and the count would agree as soon as the literal
    // moved with it. So the two sets are compared by name.
    //
    // `stopEdgeScroll` is the one exported stop the sequence does not call, and it is not a
    // lifecycle undo: it is the overlay's own, for a drag that is over. The sequence reaches it
    // through `stopSelectionOverlay`, which is asserted here rather than waved through.
    const exported = (keyword: 'start' | 'stop') =>
      MODULES.filter((name) => name !== THE_SEQUENCE).flatMap((name) =>
        exportedLifecycleFunctions(moduleSource(name), keyword, 'TerminalDocumentScope')
      )

    const started = sequenceCallsTo('startTerminalDocument')
    // `cancelDocumentFrames` is the frame registry's undo rather than a module's stop, and it is
    // asserted below by its position: last, after every stop that might still hold a frame.
    const stopped = sequenceCallsTo('stopTerminalDocument').filter(
      (name) => name !== 'cancelDocumentFrames'
    )
    expect([...started].sort()).toEqual(exported('start').sort())
    expect([...stopped].sort()).toEqual(
      exported('stop')
        .filter((name) => name !== 'stopEdgeScroll')
        .sort()
    )

    // Ruling 21: nothing is torn down under something still using it. Every module with both is
    // stopped in the reverse of the order it was started in, and the frames go last of all.
    const paired = started.filter((name) => stopped.includes(name.replace(/^start/, 'stop')))
    expect(paired.map((name) => name.replace(/^start/, 'stop'))).toEqual(
      stopped.filter((name) => paired.includes(name.replace(/^stop/, 'start'))).toReversed()
    )
    expect(sequenceCallsTo('stopTerminalDocument').at(-1)).toBe('cancelDocumentFrames')
  })
})
