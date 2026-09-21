import { readdirSync, readFileSync } from 'node:fs'
import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

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
 * function, which both hosts call — the generated script once at the foot of the document, the
 * page once per mount.
 *
 * Ruling 21's half of this — no module-level `let`, because a second mount inherited a spent error
 * budget and the first terminal's momentum loop — is not checked any more, and ruling 22 is why. A
 * module's top level is emitted inside the factory, so a `let` there is one binding per call and
 * per document, which is what the scope was being used to achieve. An effect is still refused: it
 * would run at the position its module is emitted rather than in the start sequence, so no stop
 * would undo it and every call would leak another one.
 */
/**
 * Every module of the document, read from the directory.
 *
 * From the directory rather than from a list: the bundler walks imports from the entry, so there is
 * no order to pin any more, and a module that this census cannot see is a module the rule does not
 * cover. The entry itself is the one file allowed a statement at its top level — it is the call.
 */
const ENTRY = 'native-document-entry'

/** The sequence that calls the starts, which is not a module with a start of its own. */
const THE_SEQUENCE = 'create-terminal-document'

const MODULES = readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
  .map((name) => name.replace(/\.ts$/, ''))
  .filter((name) => name !== ENTRY)
  .sort()

/** Statement kinds that only declare. Anything else at the top level is work. */
const DECLARATION_KINDS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TSDeclareFunction',
  'TSImportEqualsDeclaration',
  'EmptyStatement'
])

function moduleSource(name: string): string {
  return readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')
}

/** A node's own properties, or nothing when it is not one. Read rather than asserted. */
function fieldsOf(node: unknown): [string, unknown][] {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
    ? Object.entries(node)
    : []
}

function stringField(node: unknown, key: string): string {
  const found = fieldsOf(node).find(([name]) => name === key)?.[1]
  return typeof found === 'string' ? found : ''
}

function field(node: unknown, key: string): unknown {
  return fieldsOf(node).find(([name]) => name === key)?.[1]
}

const RUNS_NOW = new Set([
  'CallExpression',
  'NewExpression',
  'AwaitExpression',
  'TaggedTemplateExpression'
])
/** What an initialiser *is* rather than what it does: its body runs later, not now. */
const RUNS_LATER = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'])

function isElementGlobal(node: unknown): boolean {
  const name = stringField(node, 'name')
  return stringField(node, 'type') === 'Identifier' && (name === 'document' || name === 'window')
}

function initialiserRuns(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(initialiserRuns)
  }
  const type = stringField(node, 'type')
  if (RUNS_NOW.has(type)) {
    return true
  }
  if (RUNS_LATER.has(type)) {
    return false
  }
  if (type === 'MemberExpression' && isElementGlobal(field(node, 'object'))) {
    return true
  }
  return fieldsOf(node).some(([key, value]) => key !== 'type' && initialiserRuns(value))
}

/** Whether anything at a module's top level reaches an element, at any depth. */
function readsTheDocument(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(readsTheDocument)
  }
  if (isElementGlobal(node)) {
    return true
  }
  return fieldsOf(node).some(([key, value]) => key !== 'type' && readsTheDocument(value))
}

/**
 * The top-level statements that are not declarations, and the initialisers that run something.
 *
 * A declaration counts as work when its initialiser calls, constructs, awaits, or reaches into
 * `document` or `window`: `const scrollIndicator = document.getElementById(...)` is a declaration
 * by shape and a parse-time element read by effect, and it is the exact form that survived a
 * remount still holding the first mount's node. Object and regex literals are not work, which is
 * why this reads the tree rather than the text.
 */
function parseTimeEffects(name: string): string[] {
  return parseTimeEffectsIn(name, moduleSource(name))
}

function parseTimeEffectsIn(name: string, source: string): string[] {
  const { program, errors } = parseSync(`${name}.ts`, source, { lang: 'ts' })
  expect(errors).toEqual([])
  const effects: string[] = []
  for (const statement of program.body) {
    if (!DECLARATION_KINDS.has(statement.type)) {
      effects.push(`${name}: ${statement.type}`)
      continue
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? (statement.declaration ?? statement) : statement
    if (declaration.type !== 'VariableDeclaration') {
      continue
    }
    for (const declarator of declaration.declarations) {
      if (declarator.init && initialiserRuns(declarator.init)) {
        effects.push(`${name}: ${source.slice(declarator.start, declarator.end)}`)
      }
    }
  }
  return effects
}

/**
 * The names one function of the sequence calls, in the order it calls them.
 *
 * Read from the tree rather than the text, because the order is the thing being asserted and a
 * regex over the file would also match the sequence's own name in `startTerminalDocument`'s catch —
 * which is the unwind, not a module's start.
 */
function sequenceCalls(functionName: string): string[] {
  const { program } = parseSync(`${THE_SEQUENCE}.ts`, moduleSource(THE_SEQUENCE), { lang: 'ts' })
  const declaration = program.body
    .map((statement) =>
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    )
    .find(
      (node) =>
        node?.type === 'FunctionDeclaration' &&
        stringField(field(node, 'id'), 'name') === functionName
    )
  const called: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (stringField(node, 'type') === 'CallExpression') {
      const name = stringField(field(node, 'callee'), 'name')
      if (name !== '' && name !== 'startTerminalDocument' && name !== 'stopTerminalDocument') {
        called.push(name)
      }
    }
    fieldsOf(node).forEach(([key, value]) => {
      if (key !== 'type') {
        walk(value)
      }
    })
  }
  walk(declaration)
  return called
}

describe('the document modules at parse time', () => {
  it('do no work: every effect is in a start function the hosts call', () => {
    // Every module, with no exception left: the scope is built by a call now, and the constants the
    // modules own are declarations rather than the substituted literals a generator wrote.
    expect(MODULES.length).toBeGreaterThan(30)
    expect(MODULES.flatMap(parseTimeEffects)).toEqual([])
  })

  it('declare nothing that reaches an element', () => {
    // The stricter half, and the one the remount defect was: a declaration whose initialiser reads
    // an element is work by effect whatever its shape, so the same reader runs over every module.
    for (const name of MODULES) {
      const { program } = parseSync(`${name}.ts`, moduleSource(name), { lang: 'ts' })
      const topLevel = program.body.filter(
        (statement) =>
          statement.type === 'VariableDeclaration' ||
          (statement.type === 'ExportNamedDeclaration' &&
            statement.declaration?.type === 'VariableDeclaration')
      )
      expect({ name, reaches: topLevel.some(readsTheDocument) }).toEqual({ name, reaches: false })
    }
  })

  it('would report a planted element read, which the statement filter cannot see', () => {
    // The second reader has its own precondition. A `const` initialised from the document is a
    // declaration by shape and a parse-time element read by effect — the exact form that survived
    // a remount holding the first mount's node — and the statement-kind filter waves it through.
    const planted =
      "import { scope } from './document-scope'\n" +
      "const indicator = document.getElementById('scroll-indicator')\n" +
      'export function n() {\n  return indicator ?? scope.term\n}\n'
    expect(parseTimeEffectsIn('planted', planted)).toEqual([
      "planted: indicator = document.getElementById('scroll-indicator')"
    ])
    // And the element reader the case above spends on every module: the same plant, seen by it.
    const { program } = parseSync('planted.ts', planted, { lang: 'ts' })
    expect(program.body.some(readsTheDocument)).toBe(true)
    // And the other direction, because a reader that flagged every initialiser would agree with
    // the empty list above only by refusing everything: a plain literal is not work.
    const inert =
      "import { scope } from './document-scope'\n" +
      'const options = { capture: true, passive: false }\n' +
      'export function n() {\n  return options.capture && scope.term !== null\n}\n'
    expect(parseTimeEffectsIn('inert', inert)).toEqual([])
  })

  it('would report one, so the empty list above is a measurement', () => {
    // The precondition. A walk that matched nothing would agree with an empty expectation just as
    // happily, so the same reader is aimed at a module that does have a top-level effect: this
    // test file itself, whose `describe` call is exactly the shape the rule refuses.
    const source = readFileSync(
      new URL('./document-parse-time-effects.test.ts', import.meta.url),
      'utf8'
    )
    const { program } = parseSync('probe.ts', source, { lang: 'ts' })
    const running = program.body.filter((statement) => !DECLARATION_KINDS.has(statement.type))
    expect(running.length).toBeGreaterThan(0)
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
        [
          ...moduleSource(name).matchAll(
            new RegExp(
              `^export function (${keyword}[A-Za-z]+)\\(scope: TerminalDocumentScope\\) \\{$`,
              'gm'
            )
          )
        ].map((match) => match[1]!)
      )
    expect(moduleSource('selection-overlay')).toContain(
      'export function stopSelectionOverlay(scope: TerminalDocumentScope) {\n  stopEdgeScroll(scope)'
    )

    const started = sequenceCalls('startTerminalDocument')
    // `cancelDocumentFrames` is the frame registry's undo rather than a module's stop, and it is
    // asserted below by its position: last, after every stop that might still hold a frame.
    const stopped = sequenceCalls('stopTerminalDocument').filter(
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
    expect(sequenceCalls('stopTerminalDocument').at(-1)).toBe('cancelDocumentFrames')
  })

  it('would name a start the sequence forgot, which is what the comparison above is for', () => {
    // The precondition, planted rather than argued: a module that exports a start nobody calls is
    // the failure the set comparison exists to catch, and the reader has to say its name.
    const planted = sequenceCalls('startTerminalDocument')
    expect(planted).not.toContain('startReflow')
    expect([...planted, 'startReflow'].sort()).not.toEqual(planted.slice().sort())
  })
})
