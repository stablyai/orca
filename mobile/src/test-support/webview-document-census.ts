import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync } from 'oxc-parser'

// Census every WebView document with AST readers: module evaluation can retain the first mount’s nodes across remounts.
// Declarations can run work too, while literal shape alone implies no effect.

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

const RUNS_NOW = new Set([
  'CallExpression',
  'NewExpression',
  'AwaitExpression',
  'TaggedTemplateExpression'
])

/** What an initialiser *is* rather than what it does: its body runs later, not now. */
const RUNS_LATER = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'])

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

function readsTheDocument(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(readsTheDocument)
  }
  if (isElementGlobal(node)) {
    return true
  }
  return fieldsOf(node).some(([key, value]) => key !== 'type' && readsTheDocument(value))
}

function parseModule(name: string, source: string) {
  const { program, errors } = parseSync(`${name}.ts`, source, { lang: 'ts' })
  if (errors.length > 0) {
    throw new Error(`[webview-document-census] ${name}.ts did not parse: ${errors[0]?.message}`)
  }
  return program
}

// Do not descend into default-exported function bodies; declaration alone does not execute their calls.
const DECLARES_WITHOUT_RUNNING = new Set(['FunctionDeclaration', 'TSDeclareFunction'])

// Detect evaluated declaration initializers, static class members and default-export expressions as module work.
export function parseTimeEffects(name: string, source: string): string[] {
  const effects: string[] = []
  const report = (node: unknown) => {
    effects.push(`${name}: ${source.slice(numberField(node, 'start'), numberField(node, 'end'))}`)
  }

  for (const statement of parseModule(name, source).body) {
    if (!DECLARATION_KINDS.has(statement.type)) {
      effects.push(`${name}: ${statement.type}`)
      continue
    }
    const exported =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
    const declared = exported ? (field(statement, 'declaration') ?? statement) : statement
    const declaredType = stringField(declared, 'type')

    if (declaredType === 'VariableDeclaration') {
      for (const declarator of arrayField(declared, 'declarations')) {
        const init = field(declarator, 'init')
        if (init && initialiserRuns(init)) {
          report(declarator)
        }
      }
      continue
    }

    if (declaredType === 'ClassDeclaration' || declaredType === 'ClassExpression') {
      for (const member of arrayField(field(declared, 'body'), 'body')) {
        // Static blocks/fields run with class evaluation; instance fields run later at construction.
        if (stringField(member, 'type') === 'StaticBlock') {
          report(member)
        } else if (field(member, 'static') === true && initialiserRuns(field(member, 'value'))) {
          report(member)
        }
      }
      continue
    }

    if (
      statement.type === 'ExportDefaultDeclaration' &&
      !DECLARES_WITHOUT_RUNNING.has(declaredType) &&
      initialiserRuns(declared)
    ) {
      report(declared)
    }
  }
  return effects
}

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

// Read ordered lifecycle calls from the AST so unwind mentions cannot count as starts.
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

// Stop at function-owned bindings, which belong to calls; blocks still belong to the module.
const OWNS_ITS_BINDINGS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
  'TSDeclareFunction'
])

function arrayField(node: unknown, key: string): unknown[] {
  const found = field(node, key)
  return Array.isArray(found) ? found : []
}

function numberField(node: unknown, key: string): number {
  const found = field(node, key)
  return typeof found === 'number' ? found : -1
}

// Walk top-level mutable bindings through exports, blocks and loops; stop at function scopes.
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

// Find lifecycle exports by name and scope parameter, including async/wrapped declarations; textual matching can silently miss both sides of a set comparison.
export function exportedLifecycleFunctions(
  source: string,
  keyword: 'start' | 'stop',
  scopeType: string
): string[] {
  const names: string[] = []
  for (const statement of parseModule('lifecycle', source).body) {
    if (statement.type !== 'ExportNamedDeclaration') {
      continue
    }
    const declared = field(statement, 'declaration')
    if (stringField(declared, 'type') !== 'FunctionDeclaration') {
      continue
    }
    const name = stringField(field(declared, 'id'), 'name')
    if (!name.startsWith(keyword)) {
      continue
    }
    // Lifecycle starts take only scope; startEdgeScroll(scope, dir) is an action, not module startup.
    const params = arrayField(declared, 'params')
    const [first] = params
    if (params.length !== 1 || stringField(first, 'name') !== 'scope') {
      continue
    }
    const annotation = field(first, 'typeAnnotation')
    const written = source
      .slice(numberField(annotation, 'start'), numberField(annotation, 'end'))
      .replace(/^:\s*/, '')
    if (written === scopeType) {
      names.push(name)
    }
  }
  return names
}

// Discover modules from the directory so unlisted files cannot evade lifecycle rules.
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
