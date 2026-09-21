import { readFileSync } from 'node:fs'
import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_MODULE_ORDER,
  TERMINAL_DOCUMENT_SCOPE_MODULE
} from '../../../scripts/terminal-document-module-order.mjs'

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
 * Ruling 21 is the same argument about state rather than about effects. A module-level `let`
 * survives a mount just as a module body does, so the second terminal inherited a spent error
 * budget, the first terminal's committed surface and its momentum loop. Every mutable binding
 * therefore lives on the scope, which the start sequence resets first, and module top level holds
 * constants, functions and types only.
 */
const EMITTED = [
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_SCOPE_MODULE,
  ...TERMINAL_DOCUMENT_MODULE_ORDER
]

/**
 * The one module that does build something as it is parsed: the scope object every other module
 * reads. It has to exist before any of them, and on the page it is one object for the life of the
 * tab — which is safe precisely because the rule below holds for everything else. Each start
 * function writes every field it owns, so a remount resets the scope rather than inheriting it.
 * Its parse-time work touches no element, which is asserted rather than asserted-in-prose.
 */
const BUILDS_THE_SCOPE = TERMINAL_DOCUMENT_SCOPE_MODULE

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

/** Every top-level `let` or `var`: state the module owns, which a second mount would inherit. */
function mutableBindingsIn(name: string, source: string): string[] {
  const { program } = parseSync(`${name}.ts`, source, { lang: 'ts' })
  const found: string[] = []
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? (statement.declaration ?? statement) : statement
    if (declaration.type !== 'VariableDeclaration' || declaration.kind === 'const') {
      continue
    }
    found.push(`${name}: ${source.slice(declaration.start, declaration.end).split('\n')[0]}`)
  }
  return found
}

function mutableBindings(name: string): string[] {
  return mutableBindingsIn(name, moduleSource(name))
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

describe('the document modules at parse time', () => {
  it('do no work: every effect is in a start function the hosts call', () => {
    const modules = EMITTED.filter((name) => name !== BUILDS_THE_SCOPE)
    expect(modules).toContain('runtime-constants')
    expect(modules.flatMap(parseTimeEffects)).toEqual([])
  })

  it('build the scope, and only the scope, before the rest of them', () => {
    // The exception, measured. It is one module, it is the one the order list already names as
    // the scope, and nothing it does at parse time reaches an element — so a remount inherits an
    // object of fields, never a stale node.
    expect(parseTimeEffects(BUILDS_THE_SCOPE).length).toBeGreaterThan(0)
    const source = moduleSource(BUILDS_THE_SCOPE)
    const { program } = parseSync(`${BUILDS_THE_SCOPE}.ts`, source, { lang: 'ts' })
    const topLevel = program.body.filter(
      (statement) =>
        statement.type === 'VariableDeclaration' ||
        (statement.type === 'ExportNamedDeclaration' &&
          statement.declaration?.type === 'VariableDeclaration')
    )
    expect(topLevel.some(readsTheDocument)).toBe(false)
  })

  it('own no mutable state: no top-level let or var outside the scope', () => {
    expect(EMITTED.filter((name) => name !== BUILDS_THE_SCOPE).flatMap(mutableBindings)).toEqual([])
  })

  it('would report a planted one, so the empty list above is a measurement', () => {
    // The precondition for the case above, run against the same reader: a module body with a
    // `let` in it is the exact shape the rule refuses, and the reader has to say so.
    const planted = `import { scope } from './document-scope'\nlet spent = 0\nexport function n() {\n  spent++\n  return scope.term\n}\n`
    expect(mutableBindingsIn('planted', planted)).toEqual(['planted: let spent = 0'])
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

  it('still start and stop: the functions holding what was moved out are exported', () => {
    // The other half. Moving an effect out is only correct if something calls it, and the caller
    // is pinned by `page-document-module-order.test.ts` against the generator's own sequence;
    // this holds the shape of the names so that sequence can be derived rather than listed.
    const declaring = (keyword: string) =>
      EMITTED.filter((name) =>
        new RegExp(`^export function ${keyword}[A-Za-z]+\\(\\) \\{$`, 'm').test(moduleSource(name))
      )
    expect(declaring('start').length).toBe(10)
    // Ruling 21: a module that schedules a frame, a timer or a retry owes an undo for it.
    expect(declaring('stop').length).toBe(9)
  })
})
