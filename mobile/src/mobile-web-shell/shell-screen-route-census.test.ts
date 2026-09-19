import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const HOST_ROUTES = join(import.meta.dirname, '..', '..', 'app', 'h', '[hostId]')

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

const read = (name: string): string => readFileSync(join(HOST_ROUTES, name), 'utf8')

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

/** A switch is a route file that mounts the shell; its `.web.tsx` sibling is the page and never does. */
function mountsShell(source: string): boolean {
  return source.includes('<MobileWebShellScreen')
}

function importsNames(source: string, module: string): string[] {
  const parsed = ts.createSourceFile(
    'route.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
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

describe('the switches that hand a route to the shell', () => {
  const switches = hostRouteFiles().filter((name) => mountsShell(read(name)))

  it('walks the route tree and finds them, so the rules below cannot pass vacuously', () => {
    expect(switches.sort()).toEqual([
      'agent-history/[worktreeId].tsx',
      'files/[worktreeId].tsx',
      'files/preview/[worktreeId].tsx',
      'index.tsx',
      'tasks.tsx',
      'web.tsx'
    ])
  })

  it('asks shellScreenRoute whether the route is one the page can be given', () => {
    expect(
      switches
        .filter((name) => !HANDS_OVER_UNJUDGED.includes(name))
        .filter(
          (name) => !importsNames(read(name), 'shell-screen-route').includes('shellScreenRoute')
        )
    ).toEqual([])
  })

  it('spells the rule nowhere else, so the page and the app cannot disagree about it', () => {
    // The copies this census ends. `shellScreenRoute` is the one caller of the schema outside the
    // bridge, and a switch that reaches for it again is writing the second spelling back.
    expect(switches.filter((name) => read(name).includes('BridgeInitRouteSchema'))).toEqual([])
    // And the exemption names a switch that exists, so it cannot outlive the file it excuses.
    expect(switches).toEqual(expect.arrayContaining(HANDS_OVER_UNJUDGED))
  })
})
