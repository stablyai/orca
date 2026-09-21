import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync } from 'oxc-parser'

/**
 * The readers behind rulings 20 and 21, for every document that runs inside a WebView.
 *
 * There are two of them now — the terminal's and the rich Markdown editor's — and both answer the
 * same question: does a module do work as it is parsed? An ES module body runs once per page, so
 * an element read, a listener or an install left in a module body keeps the *first* mount's
 * elements forever. That is a rule about a shape rather than about a terminal, so it is checked
 * once here and pointed at each document's directory.
 *
 * The readers walk the tree rather than the text, because a declaration can be a parse-time effect
 * by what it *does* — `const editor = document.getElementById('editor')` is a declaration by shape
 * — and an object or regex literal is not work however it reads.
 */

/** Statement kinds that only declare. Anything else at a module's top level is work. */
export const DECLARATION_KINDS = new Set([
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

const RUNS_NOW = new Set([
  'CallExpression',
  'NewExpression',
  'AwaitExpression',
  'TaggedTemplateExpression'
])

/** What an initialiser *is* rather than what it does: its body runs later, not now. */
const RUNS_LATER = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'])

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
export function readsTheDocument(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(readsTheDocument)
  }
  if (isElementGlobal(node)) {
    return true
  }
  return fieldsOf(node).some(([key, value]) => key !== 'type' && readsTheDocument(value))
}

export function parseModule(name: string, source: string) {
  const { program, errors } = parseSync(`${name}.ts`, source, { lang: 'ts' })
  if (errors.length > 0) {
    throw new Error(`[webview-document-census] ${name}.ts did not parse: ${errors[0]?.message}`)
  }
  return program
}

/**
 * The top-level statements that are not declarations, and the initialisers that run something.
 *
 * A declaration counts as work when its initialiser calls, constructs, awaits, or reaches into
 * `document` or `window`, which is the exact form that survived a remount still holding the first
 * mount's node.
 */
export function parseTimeEffects(name: string, source: string): string[] {
  const effects: string[] = []
  for (const statement of parseModule(name, source).body) {
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

/** Whether a module declares anything at its top level whose initialiser reaches an element. */
export function topLevelDeclarationsReachAnElement(name: string, source: string): boolean {
  return parseModule(name, source)
    .body.filter(
      (statement) =>
        statement.type === 'VariableDeclaration' ||
        (statement.type === 'ExportNamedDeclaration' &&
          statement.declaration?.type === 'VariableDeclaration')
    )
    .some(readsTheDocument)
}

/**
 * The names one function of a start/stop sequence calls, in the order it calls them.
 *
 * Read from the tree rather than the text, because the order is the thing being asserted and a
 * regex over the file would also match the sequence's own name in its `catch` — which is the
 * unwind, not a module's start.
 */
export function sequenceCalls(source: string, functionName: string, ignore: string[]): string[] {
  const declaration = parseModule('sequence', source)
    .body.map((statement) =>
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
      if (name !== '' && !ignore.includes(name)) {
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

/**
 * What a binding *belongs to* rather than where it is written: a function's own bindings are one
 * per call, so the walk stops at every body and never at a block.
 */
const OWNS_ITS_BINDINGS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
  'TSDeclareFunction'
])

function numberField(node: unknown, key: string): number {
  const found = field(node, key)
  return typeof found === 'number' ? found : -1
}

/**
 * Every `let` and `var` a module owns, whatever shape it is written in.
 *
 * Ruling 21, and the reason it is a tree walk rather than a line match: `export let`, a declaration
 * indented inside a top-level block, and a `for (let …)` at the top level are all one binding
 * shared by every document the module serves, and none of them starts a line with the keyword. A
 * `let` inside a function body is the opposite — one binding per call — so the walk stops there.
 */
export function moduleLevelMutableBindings(name: string, source: string): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const type = stringField(node, 'type')
    if (OWNS_ITS_BINDINGS.has(type)) {
      return
    }
    if (type === 'VariableDeclaration') {
      const kind = stringField(node, 'kind')
      if (kind === 'let' || kind === 'var') {
        const declarations = field(node, 'declarations')
        for (const declarator of Array.isArray(declarations) ? declarations : []) {
          const id = field(declarator, 'id')
          found.push(
            `${name}: ${kind} ${source.slice(numberField(id, 'start'), numberField(id, 'end'))}`
          )
        }
      }
      return
    }
    fieldsOf(node).forEach(([key, value]) => {
      if (key !== 'type') {
        walk(value)
      }
    })
  }
  walk(parseModule(name, source).body)
  return found
}

/** Every `export function start…(scope: <Scope>)` a module declares, by name. */
export function exportedLifecycleFunctions(
  source: string,
  keyword: 'start' | 'stop',
  scopeType: string
): string[] {
  const pattern = new RegExp(
    `^export function (${keyword}[A-Za-z]+)\\(scope: ${scopeType}\\) \\{$`,
    'gm'
  )
  return [...source.matchAll(pattern)].map((match) => match[1]!)
}

/**
 * Every module of a document, read from its directory.
 *
 * From the directory rather than from a list: the bundler walks imports from the entry, so there
 * is no order to pin, and a module this census cannot see is a module the rule does not cover.
 */
export function documentModuleNames(directory: string, except: string[]): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
    .map((name) => name.replace(/\.ts$/, ''))
    .filter((name) => !except.includes(name))
    .sort()
}

export function documentModuleSource(directory: string, name: string): string {
  return readFileSync(join(directory, `${name}.ts`), 'utf8')
}
