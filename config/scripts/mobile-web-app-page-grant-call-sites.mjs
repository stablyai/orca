import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

/**
 * What a page route's own closure asks the shell for, read from the call sites rather than listed.
 *
 * Grants are resolved once, from the route the shell opened, and carried for the life of the
 * session: a route that reaches a seam it did not declare is a page whose action is refused at the
 * host with nothing on screen to say why. Ruling 33.3 wrote that rule once and drove it over every
 * row rather than leaving a grant pinned by the list it was copied from. Six rows pin eight of the
 * session route's thirteen grants here; the other five have censuses of their own, as does the
 * optional grant declared beside them.
 *
 * Parsed, not matched. A regex over source text finds the seam named in a comment, in a string and
 * in an import it does not call, and the first two are exactly what a census must not count.
 */

/** A grant whose call site is a function this closure calls. */
const callRow = (grants, callee, seam, why) => ({ kind: 'call', grants, callee, seam, why })
/** A grant whose call site is an import: the bundler substitutes the module, so reaching it is use. */
const importRow = (grants, specifier, why) => ({ kind: 'import', grants, specifier, why })

/**
 * One row per grant the page can ask for through a call site of its own.
 *
 * `haptics` and `screencastBinary` have their own files (`mobile-web-app-haptics-seam.test.mjs`,
 * `mobile-web-app-screencast-lane-grant.test.mjs`), the three audio grants have
 * `mobile-web-app-session-dictation-capture.test.mjs` and `externalNavigation` has
 * `mobile-web-app-external-navigation-grant.test.mjs`, so those six are not repeated here. The
 * media three share one seam and one row: `useMediaPicker` is the only way in, and `canPickMedia`
 * is `pick && read && release`, so a route reaching it needs all three or none of them.
 *
 * `externalNavigation` could not be a row here whatever it owned, and that is the rule rather than a
 * detail: a row is a call site the walk can find, and the shell's cancelled-navigation behaviour has
 * none. Nothing is requested and nothing is answered, so the only thing a closure holds is a read of
 * `init.grants.native` -- which is what its own census walks for.
 */
export const PAGE_GRANT_CALL_SITES = [
  callRow(
    ['navigate'],
    'useRouteHandoff',
    'src/navigation/route-handoff.web.ts',
    'the page keeps a route it renders and hands every other one back to the shell'
  ),
  importRow(
    ['storage'],
    '@react-native-async-storage/async-storage',
    'the bundler substitutes `page-async-storage.ts`, whose writes ride the storage notify'
  ),
  callRow(
    ['externalLink'],
    'openExternalLink',
    'src/platform/external-link.web.ts',
    'the shell is the only thing on the page that can open a URL outside the app'
  ),
  callRow(
    ['native.clipboard.write'],
    'useClipboardWriter',
    'src/platform/clipboard.web.ts',
    "the browser's own clipboard write is refused without a user gesture the page cannot prove"
  ),
  callRow(
    ['native.clipboard.read'],
    'useClipboardReader',
    'src/platform/clipboard.web.ts',
    'a paste needs the device pasteboard, which the WebView does not hand the page'
  ),
  callRow(
    ['native.media.pick', 'native.media.read', 'native.media.release'],
    'useMediaPicker',
    'src/platform/media-picker.web.ts',
    'the picker runs the OS permission prompt inside the shell and hands back a handle'
  )
]

function parse(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/**
 * Whether this module reaches the row's seam: calls the function, or imports the substituted module.
 *
 * A call and nothing else. An import of the name without a call is a module that re-exports it, and
 * a mention in a comment or a string is not a call at all — both would put a grant on a route that
 * can never ask for it, which is the failure a hand-written list already had.
 */
export function moduleReachesGrantRow(source, fileName, row) {
  let reached = false
  const walk = (node) => {
    if (
      row.kind === 'call' &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === row.callee
    ) {
      reached = true
    }
    if (
      row.kind === 'import' &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === row.specifier
    ) {
      reached = true
    }
    ts.forEachChild(node, walk)
  }
  walk(parse(source, fileName))
  return reached
}

/** Every module in the closure that reaches the row, the seam itself never counting as its own use. */
export function grantCallSites(mobileDir, closure, row) {
  return closure.local.filter((file) => {
    if (!/\.tsx?$/.test(file) || file === row.seam) {
      return false
    }
    return moduleReachesGrantRow(readFileSync(join(mobileDir, file), 'utf8'), file, row)
  })
}

/** Every grant this closure's own call sites need, in row order. */
export function grantsNeeded(mobileDir, closure) {
  return PAGE_GRANT_CALL_SITES.filter(
    (row) => grantCallSites(mobileDir, closure, row).length > 0
  ).flatMap((row) => row.grants)
}

/**
 * One row's verdict: every route whose closure reaches that seam and whose entry does not name its
 * grants, as `<pathname> needs <grant>`.
 *
 * Per row rather than per manifest, so a grant struck out of an entry reds a case named after that
 * grant. A single whole-manifest check would red under every row at once and say only that
 * something was missing.
 */
export async function grantsMissingForRow(mobileDir, routes, closureOf, row) {
  const missing = []
  for (const route of routes) {
    const closure = await closureOf(route.pathname)
    if (grantCallSites(mobileDir, closure, row).length === 0) {
      continue
    }
    for (const grant of row.grants) {
      if (!route.grants.includes(grant)) {
        missing.push(`${route.pathname} needs ${grant}`)
      }
    }
  }
  return missing
}

/**
 * Every row's verdict at once, in row order.
 *
 * One implementation under both the check and its control: a control that re-implemented the
 * filter would prove the control works and say nothing about the rule.
 */
export async function grantsMissingForRoutes(mobileDir, routes, closureOf) {
  const missing = []
  for (const row of PAGE_GRANT_CALL_SITES) {
    missing.push(...(await grantsMissingForRow(mobileDir, routes, closureOf, row)))
  }
  return missing
}
