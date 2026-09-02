import ts from 'typescript'
import {
  MOBILE_TASKS_SOURCE_FILES,
  readMobileTasksSource
} from './mobile-tasks-source-family.test-support'

type FunctionDefinition = {
  body: ts.Block
  sourceFile: ts.SourceFile
}

const TASKS_ROUTE = '../../app/h/[hostId]/tasks.tsx'
const FOUNDATION_SOURCE = 'mobile-tasks-legacy-foundation.tsx'
const LEGACY_STYLE_SOURCE = 'mobile-tasks-legacy-styles.ts'

function parseSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readMobileTasksSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function normalized(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node
    .getText(sourceFile)
    .replace(/\/\/ react-doctor-disable-next-line [^\n]*\n/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function functionBody(sourceFile: ts.SourceFile, functionName: string): ts.Block {
  let match: ts.Block | null = null
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
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

function hookDefinitions(): Map<string, FunctionDefinition> {
  const definitions = new Map<string, FunctionDefinition>()
  for (const relativePath of MOBILE_TASKS_SOURCE_FILES) {
    const sourceFile = parseSource(relativePath)
    function visit(node: ts.Node): void {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text.startsWith('useMobileTasks') &&
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

function assignedHookName(statement: ts.Statement): string | null {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
    return null
  }
  const initializer = statement.declarationList.declarations[0]?.initializer
  return initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
    ? initializer.expression.text
    : null
}

function isModelDestructure(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
    return false
  }
  const declaration = statement.declarationList.declarations[0]
  return (
    declaration != null &&
    ts.isObjectBindingPattern(declaration.name) &&
    declaration.initializer != null &&
    ts.isIdentifier(declaration.initializer) &&
    declaration.initializer.text === 'model'
  )
}

function flattenStageStatements(
  definition: FunctionDefinition,
  definitions: ReadonlyMap<string, FunctionDefinition>,
  active: ReadonlySet<string>
): string[] {
  const signatures: string[] = []
  for (const statement of definition.body.statements) {
    if (ts.isReturnStatement(statement) || isModelDestructure(statement)) {
      continue
    }
    const nestedName = assignedHookName(statement)
    const nestedDefinition = nestedName ? definitions.get(nestedName) : undefined
    if (nestedName && nestedDefinition) {
      if (active.has(nestedName)) {
        throw new Error(`Recursive Mobile Tasks statement stage: ${nestedName}`)
      }
      signatures.push(
        ...flattenStageStatements(nestedDefinition, definitions, new Set([...active, nestedName]))
      )
      continue
    }
    signatures.push(normalized(statement, definition.sourceFile))
  }
  return signatures
}

export function readFlattenedMobileTasksCoreStatements(): string[] {
  const definitions = hookDefinitions()
  const route = parseSource(TASKS_ROUTE)
  const signatures: string[] = []
  for (const statement of functionBody(route, 'MobileTasksScreen').statements) {
    if (ts.isReturnStatement(statement)) {
      continue
    }
    const stageName = assignedHookName(statement)
    const definition = stageName ? definitions.get(stageName) : undefined
    if (!stageName || !definition) {
      throw new Error('Unexpected Mobile Tasks route statement')
    }
    signatures.push(...flattenStageStatements(definition, definitions, new Set([stageName])))
  }
  return signatures
}

function foundationSources(): string[] {
  const foundation = parseSource(FOUNDATION_SOURCE)
  const sources = foundation.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return []
    }
    const base = statement.moduleSpecifier.text.replace(/^\.\//, '')
    return [`${base}.ts`, `${base}.tsx`].filter((candidate) =>
      MOBILE_TASKS_SOURCE_FILES.includes(candidate)
    )
  })
  return [...sources, LEGACY_STYLE_SOURCE]
}

function printedDeclaration(node: ts.Node, sourceFile: ts.SourceFile, printer: ts.Printer): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/^export\s+(?:default\s+)?/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function readMobileTasksDeclarationSignatures(): string[] {
  const printer = ts.createPrinter({ removeComments: true })
  const signatures: string[] = []
  for (const relativePath of foundationSources()) {
    const sourceFile = parseSource(relativePath)
    for (const statement of sourceFile.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        signatures.push(
          `${statement.name.text}:${printedDeclaration(statement, sourceFile, printer)}`
        )
        continue
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text !== 'styles') {
            signatures.push(
              `${declaration.name.text}:${printedDeclaration(declaration, sourceFile, printer)}`
            )
          }
        }
      }
    }
  }
  return signatures.sort()
}
