import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

// Session grants come from opening route and persist: undeclared reachable seams silently refuse actions.
// Parse actual calls/imports; regex also counts comments, strings and unused imports.

/** A grant whose call site is a function this closure calls. */
const callRow = (grants, callee, seam, why) => ({ kind: 'call', grants, callee, seam, why })
/** A grant whose call site is an import: the bundler substitutes the module, so reaching it is use. */
const importRow = (grants, specifier, why) => ({ kind: 'import', grants, specifier, why })

// Haptics, screencastBinary, audio and externalNavigation have separate censuses. Media needs pick/read/release together through useMediaPicker.
// externalNavigation has no request/notify call site: its census follows init.grants.native reads instead.
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

function grantReferences(source, fileName) {
  const calls = new Set()
  const imports = new Set()
  const walk = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.add(node.expression.text)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(parse(source, fileName))
  return { calls, imports }
}

function referencesReachRow(references, row) {
  return row.kind === 'call'
    ? references.calls.has(row.callee)
    : row.kind === 'import' && references.imports.has(row.specifier)
}

// Count actual calls or substituted-module imports; reexports and string/comment mentions cannot request grants.
export function moduleReachesGrantRow(source, fileName, row) {
  return referencesReachRow(grantReferences(source, fileName), row)
}

// One source version per file, scoped to a census; edits invalidate the parsed references.
export function createGrantCallSiteReader() {
  const files = new Map()
  return (source, fileName, row) => {
    let held = files.get(fileName)
    if (held?.source !== source) {
      held = { source, references: grantReferences(source, fileName) }
      files.set(fileName, held)
    }
    return referencesReachRow(held.references, row)
  }
}

/** Every module in the closure that reaches the row, the seam itself never counting as its own use. */
export function grantCallSites(mobileDir, closure, row, readModule = moduleReachesGrantRow) {
  return closure.local.filter((file) => {
    if (!/\.tsx?$/.test(file) || file === row.seam) {
      return false
    }
    return readModule(readFileSync(join(mobileDir, file), 'utf8'), file, row)
  })
}

/** Every grant this closure's own call sites need, in row order. */
export function grantsNeeded(mobileDir, closure, readModule) {
  return PAGE_GRANT_CALL_SITES.filter(
    (row) => grantCallSites(mobileDir, closure, row, readModule).length > 0
  ).flatMap((row) => row.grants)
}

// Report per-row missing grants so a failure names its own grant instead of reddening every manifest case.
export async function grantsMissingForRow(mobileDir, routes, closureOf, row, readModule) {
  const missing = []
  for (const route of routes) {
    const closure = await closureOf(route.pathname)
    if (grantCallSites(mobileDir, closure, row, readModule).length === 0) {
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

// Use same verdict implementation for checks and controls; a separate control filter would prove only itself.
export async function grantsMissingForRoutes(mobileDir, routes, closureOf) {
  const missing = []
  for (const row of PAGE_GRANT_CALL_SITES) {
    missing.push(...(await grantsMissingForRow(mobileDir, routes, closureOf, row)))
  }
  return missing
}
