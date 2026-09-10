import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const TASKS_DIRECTORY = __dirname
const TASKS_ROUTE = '../../app/h/[hostId]/tasks.tsx'
const SOURCE_PATTERN = /^(?:MobileTasks.*\.tsx|mobile-tasks-.*\.tsx?|use-mobile-tasks-.*\.tsx?)$/

export const MOBILE_TASKS_SOURCE_FILES = [
  TASKS_ROUTE,
  ...readdirSync(TASKS_DIRECTORY)
    .filter(
      (name) =>
        SOURCE_PATTERN.test(name) &&
        name !== 'mobile-tasks-capability.ts' &&
        !name.includes('.test.') &&
        !name.includes('.test-support.')
    )
    .sort()
]

export function readMobileTasksSource(relativePath: string): string {
  return readFileSync(join(TASKS_DIRECTORY, relativePath), 'utf8')
}

export function readMobileTasksSourceFamily(): string {
  return MOBILE_TASKS_SOURCE_FILES.map(
    (relativePath) =>
      `// Mobile Tasks source: ${relativePath}\n${readMobileTasksSource(relativePath)}`
  ).join('\n')
}

function parseSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readMobileTasksSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function functionBody(sourceFile: ts.SourceFile, functionName: string): ts.Block {
  let match: ts.Block | null = null
  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === functionName &&
      node.body
    ) {
      match = node.body
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!match) {
    throw new Error(`Missing Mobile Tasks function: ${functionName}`)
  }
  return match
}

function callName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text
  }
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text
  }
  return null
}

function directHookCalls(body: ts.Block): Array<{ name: string; call: ts.CallExpression }> {
  const calls: Array<{ name: string; call: ts.CallExpression }> = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = callName(node)
      if (name && /^use[A-Z0-9]/.test(name)) {
        calls.push({ name, call: node })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return calls
}

function normalized(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim()
}

function hookDefinitions(): Map<string, { body: ts.Block; sourceFile: ts.SourceFile }> {
  const definitions = new Map<string, { body: ts.Block; sourceFile: ts.SourceFile }>()
  for (const relativePath of MOBILE_TASKS_SOURCE_FILES) {
    const sourceFile = parseSource(relativePath)
    function visit(node: ts.Node): void {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.name.text.startsWith('useMobileTasks') &&
        node.body
      ) {
        definitions.set(node.name.text, { body: node.body, sourceFile })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

function flattenHooks(
  body: ts.Block,
  sourceFile: ts.SourceFile,
  definitions: ReadonlyMap<string, { body: ts.Block; sourceFile: ts.SourceFile }>,
  active: ReadonlySet<string>
): string[] {
  return directHookCalls(body).flatMap(({ name, call }) => {
    const definition = definitions.get(name)
    if (definition) {
      if (active.has(name)) {
        throw new Error(`Recursive Mobile Tasks hook stage: ${name}`)
      }
      return flattenHooks(
        definition.body,
        definition.sourceFile,
        definitions,
        new Set([...active, name])
      )
    }
    return [`${name}:${normalized(call, sourceFile)}`]
  })
}

export function readFlattenedMobileTasksHookSignatures(functionName: string): string[] {
  const definitions = hookDefinitions()
  for (const relativePath of MOBILE_TASKS_SOURCE_FILES) {
    const sourceFile = parseSource(relativePath)
    try {
      return flattenHooks(
        functionBody(sourceFile, functionName),
        sourceFile,
        definitions,
        new Set()
      )
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('Missing Mobile Tasks function:')
      ) {
        throw error
      }
    }
  }
  throw new Error(`Missing Mobile Tasks root function: ${functionName}`)
}

export function readMobileTasksSemanticSource(): string {
  return MOBILE_TASKS_SOURCE_FILES.map((relativePath) => {
    const sourceFile = parseSource(relativePath)
    const signatures: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = callName(node)
        if (name === 'sendRequest') {
          signatures.push(`rpc:${normalized(node, sourceFile)}`)
        }
      }
      if (
        ts.isStringLiteralLike(node) &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent)
      ) {
        signatures.push(`string:${JSON.stringify(node.text)}`)
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        signatures.push(
          `jsx:${node.tagName.getText(sourceFile)}:${node.attributes.properties
            .map((attribute) => attribute.name?.getText(sourceFile) ?? 'spread')
            .join(',')}`
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return signatures.sort().join('\n')
  })
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .sort()
    .join('\n')
}

export function readMobileTasksStyleSource(): string {
  const styles: string[] = []
  for (const relativePath of MOBILE_TASKS_SOURCE_FILES) {
    const sourceFile = parseSource(relativePath)
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'StyleSheet' &&
        node.expression.name.text === 'create' &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const property of node.arguments[0].properties) {
          styles.push(normalized(property, sourceFile))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return styles.sort().join('\n')
}
