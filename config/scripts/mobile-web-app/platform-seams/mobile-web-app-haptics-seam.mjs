// Measure notify kinds rather than empty function bodies: old web no-ops were indistinguishable from unread source.
// Native sibling’s five nonposting functions provide negative control; share census across routes to prevent rule drift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

export const HAPTICS_SEAM = 'src/platform/haptics.web.ts'

// Native sibling imports expo-haptics and must stay outside page closure.
export const HAPTICS_NATIVE = 'src/platform/haptics.ts'

export const HAPTICS_KINDS_MODULE = 'src/mobile-web-shell/bridge/bridge-haptics-notify.ts'

const KINDS_CONST = 'BRIDGE_HAPTICS_KINDS'
const PUBLISH_FUNCTION = 'publishHapticsNotifier'

const parse = (source, fileName) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)

// Parse tuple declaration to ignore string/comment mentions and quote style.
export function bridgeHapticsKinds(source, fileName = 'bridge-haptics-notify.ts') {
  const parsed = parse(source, fileName)
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== KINDS_CONST) {
        continue
      }
      const initializer =
        declaration.initializer !== undefined && ts.isAsExpression(declaration.initializer)
          ? declaration.initializer.expression
          : declaration.initializer
      if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
        continue
      }
      return initializer.elements
        .filter((element) => ts.isStringLiteral(element))
        .map((element) => element.text)
    }
  }
  return []
}

// Derive notifier binding from publishHapticsNotifier; hardcoded local post would silently miss calls after rename.
function notifierBinding(parsed) {
  let binding = null
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === PUBLISH_FUNCTION
    ) {
      const assign = (inner) => {
        if (
          ts.isBinaryExpression(inner) &&
          inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(inner.left)
        ) {
          binding = inner.left.text
        }
        ts.forEachChild(inner, assign)
      }
      ts.forEachChild(node, assign)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return binding
}

// Computed kind has no statically provable literal and reports none.
function literalArguments(call) {
  return call.arguments.filter((argument) => ts.isStringLiteral(argument)).map((a) => a.text)
}

// Report exported trigger functions/kinds as sites; null distinguishes nonposting native/old-web functions from actual notifications.
export function hapticsTriggerSites(source, fileName = 'haptics.ts') {
  const parsed = parse(source, fileName)
  const binding = notifierBinding(parsed)
  const lineOf = (node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
  const sites = []
  for (const statement of parsed.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name === undefined ||
      !statement.name.text.startsWith('trigger') ||
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !==
        true
    ) {
      continue
    }
    const posted = []
    if (binding !== null && statement.body !== undefined) {
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === binding) {
            posted.push(...literalArguments(node))
          }
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(statement.body, visit)
    }
    sites.push({
      name: statement.name.text,
      line: lineOf(statement),
      // Exactly one kind/call per function avoids double haptic for one gesture.
      kind: posted.length === 1 ? posted[0] : null
    })
  }
  return sites
}

export function hapticsPostedKinds(source, fileName = 'haptics.ts') {
  return hapticsTriggerSites(source, fileName)
    .map((site) => site.kind)
    .filter((kind) => kind !== null)
}

// Compare shell imports against all app exports: compile checks reject unknown imports but miss new haptic with no page kind.
export function hapticsImportedNames(source, fileName = 'module.ts') {
  const parsed = parse(source, fileName)
  const names = []
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(?:\.\.?\/)+platform\/haptics$/.test(statement.moduleSpecifier.text)
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      // Judge imported export name, not local alias.
      names.push(...bindings.elements.map((element) => (element.propertyName ?? element.name).text))
    }
  }
  return [...new Set(names)].sort()
}

// Consumers import extensionless seam; census checks closure resolved web sibling rather than native expo-haptics path.
export function hapticsSeamImporters(mobileDir, closure) {
  const specifier = /(?:^|['"])(?:\.\.?\/)+platform\/haptics(?:\.web)?['"]$/
  return closure.local
    .filter((file) => file !== HAPTICS_SEAM && file !== HAPTICS_NATIVE)
    .filter((file) => {
      let source
      try {
        source = readFileSync(join(mobileDir, file), 'utf8')
      } catch {
        return false
      }
      const parsed = parse(source, file)
      return parsed.statements.some(
        (statement) =>
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          specifier.test(`'${statement.moduleSpecifier.text}'`)
      )
    })
    .sort()
}
