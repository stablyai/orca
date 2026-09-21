/**
 * The haptics seam, and how a census tells a page function that asks the shell from one that does
 * nothing.
 *
 * `haptics.web.ts` used to be five empty bodies, which is a shape no scan can distinguish from a
 * file it failed to read: an empty result and a green census meant the same thing. Now each of the
 * five posts one `native.haptics.trigger` notify carrying its own kind, so the census measures the
 * kinds it found — and runs the same walk over the native sibling, where the same five functions
 * exist and none of them posts, as the control that says the walk can tell the two apart.
 *
 * Shared rather than restated in each route's census, for the reason
 * `mobile-web-app-external-link-seam.mjs` is: two spellings of one rule drift.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

/** The seam as the web build resolves it: `.web.ts` wins under the builder's `resolveExtensions`. */
export const HAPTICS_SEAM = 'src/platform/haptics.web.ts'

/** Its native sibling, which the page must never resolve to — it imports `expo-haptics`. */
export const HAPTICS_NATIVE = 'src/platform/haptics.ts'

/** The module that declares the kinds, so a census reads them instead of listing them again. */
export const HAPTICS_KINDS_MODULE = 'src/mobile-web-shell/bridge/bridge-haptics-notify.ts'

const KINDS_CONST = 'BRIDGE_HAPTICS_KINDS'
const PUBLISH_FUNCTION = 'publishHapticsNotifier'

const parse = (source, fileName) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)

/**
 * The kinds the notify admits, read off the tuple that declares them.
 *
 * Parsed rather than matched, so a mention of the name in a comment or a docstring is not a
 * declaration, and so the quote style is settled for free.
 */
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
      // `as const` wraps the literal in an assertion expression; the tuple is inside it.
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

/**
 * The name of the module-level binding `publishHapticsNotifier` assigns, or null in a module that
 * publishes nothing.
 *
 * Derived rather than assumed: the census must not be keyed on a local called `post`, because
 * renaming it would silently turn every posting site into a non-posting one and leave the census
 * green on a page with no haptics at all.
 */
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

/** Every string literal this call is handed, so a site that posts a computed kind reports none. */
function literalArguments(call) {
  return call.arguments.filter((argument) => ts.isStringLiteral(argument)).map((a) => a.text)
}

/**
 * Every exported `trigger…` function in a haptics module, and the kind it posts.
 *
 * `kind` is null for a function that posts nothing, which is what the native sibling's five are and
 * what the web sibling's five used to be. Reported as sites rather than as a boolean because a
 * census whose red names `path:line` is read once and one that names a file is grepped for.
 */
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
      // One kind per call and one call per function: two would be two taps for one gesture.
      kind: posted.length === 1 ? posted[0] : null
    })
  }
  return sites
}

/** The kinds a module posts, in the order its functions are declared. */
export function hapticsPostedKinds(source, fileName = 'haptics.ts') {
  return hapticsTriggerSites(source, fileName)
    .map((site) => site.kind)
    .filter((kind) => kind !== null)
}

/**
 * The names a module imports from the app's haptics, which is how the shell's mapping is held to it.
 *
 * `page-haptics.ts` names each function as a named import rather than reaching a namespace, so a
 * row naming something `haptics.ts` does not export is already a compile error. This is the other
 * direction, which no type states: a haptic that file grows with no kind of its own would be one
 * the page can never ask for, and comparing this list against the file's own exports is the only
 * thing that sees it.
 */
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
      // The imported name, not the local one: a renamed import is the same export.
      names.push(...bindings.elements.map((element) => (element.propertyName ?? element.name).text))
    }
  }
  return [...new Set(names)].sort()
}

/**
 * Every module in a closure that imports the haptics seam, as the path the closure reports.
 *
 * The specifier is read extensionless, because that is how a consumer writes it and how the builder
 * resolves it: a module importing `../platform/haptics` gets the `.web.ts` on the page and the
 * native file on a phone, and the census's job is to say which one the closure ended up with.
 */
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
