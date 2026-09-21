import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const HOST_ROUTES = join(import.meta.dirname, '..', '..', 'app', 'h', '[hostId]')
const PAGE_ROUTE_REGISTRY = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'config',
  'scripts',
  'mobile-web-page-routes.mjs'
)

/**
 * Every switch that hands a route to the shell asks whether the route is one the page can be
 * given, and asks it in one place.
 *
 * A route the schema refuses is dropped to `null` by `bridge-host.ts` and reaches the phone as an
 * `init` naming no screen, which the page answers with "Update Orca to open this workspace" — a
 * failure screen in place of the native screen sitting right behind the switch. Three routes had
 * each grown their own copy of the call and two had none at all, which is the state this census
 * ends: the predicate is `shellScreenRoute`, and a switch that spells it itself has a second
 * spelling of a rule that can only drift from the one the page reads.
 *
 * The walk is over the route tree rather than a list, so a route added later is held to this
 * without anyone remembering to add it here.
 */
function hostRouteFiles(directory: string = HOST_ROUTES, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      return hostRouteFiles(join(directory, entry.name), name)
    }
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [name] : []
  })
}

/**
 * A route file's body: the file itself, or the module its default export comes from.
 *
 * `[...page].tsx` is the reason: expo-router 55 reads a file's platform from the first dot of its
 * stripped name, so a catch-all cannot carry a `.web.tsx` sibling under `app/` without registering
 * a second route, and its body lives under `src/` where the stem is plain. Following the export
 * keeps the walk derived from the tree rather than from a list beside it.
 *
 * Fails closed, which is the half that matters. A shape this cannot resolve is a file whose body
 * it never read, and an unread body is exactly where a switch that skips `shellScreenRoute` would
 * sit — so an unknown shape is named by the census rather than quietly treated as a non-switch.
 */
type RouteBody =
  | { readonly kind: 'source'; readonly text: string }
  | { readonly kind: 'unresolved'; readonly why: string }

/** The module specifier a file's default export comes from, or null when the body is local. */
function defaultExportSource(parsed: ts.SourceFile): string | null | undefined {
  const importedFrom = new Map<string, string>()
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      if (clause?.name !== undefined) {
        importedFrom.set(clause.name.text, statement.moduleSpecifier.text)
      }
      const bindings = clause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importedFrom.set(element.name.text, statement.moduleSpecifier.text)
        }
      }
    }
  }
  for (const statement of parsed.statements) {
    // `export { default } from 'x'`, and `export { Body as default } from 'x'`.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === 'default')
    ) {
      return statement.moduleSpecifier.text
    }
    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      // `export default Body` where `Body` came from an import: the body is over there. Any other
      // expression — a function, a class, a local — is this file's own.
      return ts.isIdentifier(statement.expression)
        ? (importedFrom.get(statement.expression.text) ?? null)
        : null
    }
    // `export default function …` / `export default class …`: the body is here.
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
        true
    ) {
      return null
    }
  }
  return undefined
}

function bodyOf(name: string): RouteBody {
  const routeFile = join(HOST_ROUTES, name)
  const source = readFileSync(routeFile, 'utf8')
  const specifier = defaultExportSource(parse(source))
  if (specifier === undefined) {
    return { kind: 'unresolved', why: 'no default export this census recognises' }
  }
  if (specifier === null) {
    return { kind: 'source', text: source }
  }
  if (!specifier.startsWith('.')) {
    return { kind: 'unresolved', why: `default export comes from the package "${specifier}"` }
  }
  const base = resolve(dirname(routeFile), specifier)
  for (const extension of ['.tsx', '.ts']) {
    if (existsSync(`${base}${extension}`)) {
      return { kind: 'source', text: readFileSync(`${base}${extension}`, 'utf8') }
    }
  }
  return { kind: 'unresolved', why: `no module at "${specifier}"` }
}

/** The body text, for the rules below; an unresolved shape is caught by its own case first. */
function read(name: string): string {
  const body = bodyOf(name)
  return body.kind === 'source' ? body.text : ''
}

/**
 * The one switch that hands over a route the rule refuses, on purpose.
 *
 * `web.tsx` is `__DEV__`-only and its fallback is `Redirect href="/h/<hostId>"`, not a native
 * screen. Adopting the guard there sends a `..` deep link through that redirect to the host route,
 * which this PR keeps native, so the developer lands on the host list with nothing said about why
 * the page did not open. Handed over instead, the same id reaches the bridge and comes back as the
 * host's own failure screen, which is the better verdict for a route whose whole purpose is to
 * open the page deliberately; `mobile-web-shell-route.test.tsx` pins that by name.
 *
 * Exempted here rather than silently unwalked, so the exception is read when it changes.
 */
const HANDS_OVER_UNJUDGED = ['web.tsx']

const parse = (source: string): ts.SourceFile =>
  ts.createSourceFile('route.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function importsNames(parsed: ts.SourceFile, module: string): string[] {
  return parsed.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return []
    }
    if (!statement.moduleSpecifier.text.endsWith(module)) {
      return []
    }
    const bindings = statement.importClause?.namedBindings
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => element.name.text)
      : []
  })
}

/**
 * A switch is a route file that imports the shell screen.
 *
 * The import rather than `<MobileWebShellScreen` in the text: a switch that renders it through an
 * alias, or across a line break the formatter chose, is still a switch, and a file that only
 * mentions the name in a comment is not one.
 */
function mountsShell(parsed: ts.SourceFile): boolean {
  return importsNames(parsed, 'MobileWebShellScreen').includes('MobileWebShellScreen')
}

/**
 * Whether the module calls the name it imported, not merely imports it.
 *
 * An import alone is what a switch has while the call sits behind a condition that never runs, or
 * after someone deletes the call and leaves the import for the formatter to trim later. The rule
 * is that every switch asks, so the census reads the asking.
 */
function callsName(parsed: ts.SourceFile, name: string): boolean {
  let called = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      called = true
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return called
}

describe('the switches that hand a route to the shell', () => {
  const switches = hostRouteFiles().filter((name) => mountsShell(parse(read(name))))

  it('walks the directory every registered route lives under', () => {
    // The root above is written out rather than derived, so this is what ties it to the manifest:
    // a page route outside `/h/[hostId]` would be a switch this census never reads.
    const pathnames = [
      ...readFileSync(PAGE_ROUTE_REGISTRY, 'utf8').matchAll(/pathname: '([^']+)'/g)
    ].map((match) => match[1])
    expect(pathnames.length).toBeGreaterThan(0)
    expect(pathnames.filter((pathname) => !pathname.startsWith('/h/[hostId]'))).toEqual([])
  })

  /**
   * Every route file's body was read, so `switches` is a census and not a sample.
   *
   * A shape this cannot resolve is a body it never opened, and every rule below would read that
   * file as "not a switch" — the one answer a census must never give by default.
   */
  it('resolves every route file to a body, naming any shape it cannot', () => {
    expect(
      hostRouteFiles()
        .map((name) => ({ name, body: bodyOf(name) }))
        .filter((entry) => entry.body.kind === 'unresolved')
        .map((entry) => `${entry.name}: ${entry.body.kind === 'unresolved' ? entry.body.why : ''}`)
    ).toEqual([])
  })

  it('walks the route tree and finds them, so the rules below cannot pass vacuously', () => {
    expect(switches.sort()).toEqual([
      '[...page].tsx',
      'agent-history/[worktreeId].tsx',
      'files/[worktreeId].tsx',
      'files/preview/[worktreeId].tsx',
      'index.tsx',
      'review/[worktreeId].tsx',
      'source-control/[worktreeId].tsx',
      'tasks.tsx',
      'web.tsx'
    ])
  })

  it('asks shellScreenRoute whether the route is one the page can be given', () => {
    // Imports it *and* calls it: an import the call no longer reaches is a switch that stopped
    // asking while still looking like one.
    expect(
      switches
        .filter((name) => !HANDS_OVER_UNJUDGED.includes(name))
        .filter((name) => {
          const parsed = parse(read(name))
          return (
            !importsNames(parsed, 'shell-screen-route').includes('shellScreenRoute') ||
            !callsName(parsed, 'shellScreenRoute')
          )
        })
    ).toEqual([])
  })

  it('reads the call rather than the import, on a fixture that has only the import', () => {
    // The rule the case above cannot show against the tree, every switch there calling what it
    // imports: an import with no call is named.
    const importOnly = parse(
      "import { shellScreenRoute } from '../../../src/mobile-web-shell/shell-screen-route'\n" +
        "import { MobileWebShellScreen } from '../../../src/mobile-web-shell/MobileWebShellScreen'\n" +
        'export default function Route() {\n  return <MobileWebShellScreen />\n}\n'
    )
    expect(mountsShell(importOnly)).toBe(true)
    expect(importsNames(importOnly, 'shell-screen-route')).toContain('shellScreenRoute')
    expect(callsName(importOnly, 'shellScreenRoute')).toBe(false)
  })

  it('spells the rule nowhere else, so the page and the app cannot disagree about it', () => {
    // The copies this census ends. `shellScreenRoute` is the one caller of the schema outside the
    // bridge, and a switch that reaches for it again is writing the second spelling back.
    expect(switches.filter((name) => read(name).includes('BridgeInitRouteSchema'))).toEqual([])
    // And the exemption names a switch that exists, so it cannot outlive the file it excuses.
    expect(switches).toEqual(expect.arrayContaining(HANDS_OVER_UNJUDGED))
  })
})
