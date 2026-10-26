// Native image/document picker imports throw in browser and can break entire manifest; clipboard getImageAsync instead needs secure context absent under iOS scheme.
// Share census across routes so future consumers cannot bypass one copy of rule.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

export const MEDIA_PICKER_SEAM = 'src/platform/media-picker.web.ts'

export const NATIVE_PICKER_MODULES = ['expo-image-picker', 'expo-document-picker']

const CLIPBOARD_MODULE = 'expo-clipboard'
const CLIPBOARD_IMAGE_READ = 'getImageAsync'

// Parse imports/reexports of native picker modules regardless of use: their top level throws, including side-effect imports.
// Allow expo-clipboard text APIs; report named getImageAsync imports or namespace/default property uses only.
// Infer kind from filename: TSX parsing of TS generic arrows can hide later offending calls.
export function mediaPickerSites(source, fileName = 'module.tsx') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
  const sites = []
  const clipboardAliases = new Set()
  const specifierOf = (statement) =>
    statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null
  // Read imported/destructured propertyName before local alias; nested patterns/computed keys may lack readable identifier.
  const namesImageRead = (elements) =>
    elements.some((element) => {
      const named = element.propertyName ?? element.name
      return (
        (ts.isIdentifier(named) || ts.isStringLiteral(named)) && named.text === CLIPBOARD_IMAGE_READ
      )
    })

  const declaredFromAlias = (node) =>
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    ts.isIdentifier(node.initializer) &&
    clipboardAliases.has(node.initializer.text)

  for (const statement of parsed.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? specifierOf(statement)
        : null
    if (specifier === null) {
      continue
    }
    if (NATIVE_PICKER_MODULES.includes(specifier)) {
      sites.push(lineOf(statement))
      continue
    }
    if (specifier !== CLIPBOARD_MODULE) {
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      // Export * exposes getImageAsync too.
      if (clause === undefined || ts.isNamespaceExport(clause) || namesImageRead(clause.elements)) {
        sites.push(lineOf(statement))
      }
      continue
    }
    const clause = statement.importClause
    if (clause === undefined) {
      continue
    }
    if (clause.name !== undefined) {
      clipboardAliases.add(clause.name.text)
    }
    const bindings = clause.namedBindings
    if (bindings === undefined) {
      continue
    }
    if (ts.isNamespaceImport(bindings)) {
      clipboardAliases.add(bindings.name.text)
      continue
    }
    if (namesImageRead(bindings.elements)) {
      sites.push(lineOf(statement))
    }
  }

  // Literal dynamic import enters bundler closure like static import; unwrap await/parentheses but do not guess computed specifiers.
  const dynamicImportOf = (node) => {
    let value = node
    while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) {
      value = value.expression
    }
    if (
      !ts.isCallExpression(value) ||
      value.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      value.arguments.length === 0
    ) {
      return null
    }
    const [specifier] = value.arguments
    return ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)
      ? specifier.text
      : null
  }

  const seedDynamic = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const specifier = dynamicImportOf(node.initializer)
      if (specifier === CLIPBOARD_MODULE) {
        if (ts.isIdentifier(node.name)) {
          clipboardAliases.add(node.name.text)
        } else if (ts.isObjectBindingPattern(node.name) && namesImageRead(node.name.elements)) {
          sites.push(lineOf(node))
        }
      }
    }
    // Any native picker module reach is forbidden, regardless of resulting alias.
    if (ts.isCallExpression(node)) {
      const specifier = dynamicImportOf(node)
      if (specifier !== null && NATIVE_PICKER_MODULES.includes(specifier)) {
        sites.push(lineOf(node))
      }
    }
    ts.forEachChild(node, seedDynamic)
  }
  ts.forEachChild(parsed, seedDynamic)

  if (clipboardAliases.size > 0) {
    // Learn transitive namespace aliases to fixed point; valid deferred uses can precede declarations in source order.
    for (let grew = true; grew;) {
      grew = false
      const learn = (node) => {
        if (
          declaredFromAlias(node) &&
          ts.isIdentifier(node.name) &&
          !clipboardAliases.has(node.name.text)
        ) {
          clipboardAliases.add(node.name.text)
          grew = true
        }
        ts.forEachChild(node, learn)
      }
      ts.forEachChild(parsed, learn)
    }

    // Read dotted, quoted and substitution-free template keys equivalently; computed identifiers/templates are unknown and must not be guessed.
    const readsImageOffAlias = (node) => {
      if (!ts.isIdentifier(node.expression) || !clipboardAliases.has(node.expression.text)) {
        return false
      }
      if (ts.isPropertyAccessExpression(node)) {
        return node.name.text === CLIPBOARD_IMAGE_READ
      }
      const key = node.argumentExpression
      return (
        key !== undefined &&
        (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
        key.text === CLIPBOARD_IMAGE_READ
      )
    }

    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        readsImageOffAlias(node)
      ) {
        sites.push(lineOf(node))
      }
      // Destructuring getImageAsync bypasses property-access scan; report declaration that exposes forbidden function.
      if (
        declaredFromAlias(node) &&
        ts.isObjectBindingPattern(node.name) &&
        namesImageRead(node.name.elements)
      ) {
        sites.push(lineOf(node))
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(parsed, visit)
  }
  return [...new Set(sites)].sort((left, right) => left - right)
}

// Return closure offenders as path:line; external mobile-relative paths missing here belong to caller’s resolver, not guessed offences.
export function mediaPickerOffenders(mobileDir, closure) {
  return closure.local
    .filter((file) => file !== MEDIA_PICKER_SEAM)
    .flatMap((file) => {
      let source
      try {
        source = readFileSync(join(mobileDir, file), 'utf8')
      } catch {
        return []
      }
      return mediaPickerSites(source, file).map((line) => [file, line])
    })
    .sort(([leftFile, leftLine], [rightFile, rightLine]) =>
      leftFile === rightFile ? leftLine - rightLine : leftFile < rightFile ? -1 : 1
    )
    .map(([file, line]) => `${file}:${line}`)
}
