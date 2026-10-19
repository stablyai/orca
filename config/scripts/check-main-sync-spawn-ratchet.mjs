import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  totalCount
} from './ratchet-baseline.mjs'
import { literalString, propertyName, unwrap } from './static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Ratchet for synchronous child-process launches in Electron main and shared code: each one
// freezes every window until the child exits, and on Windows antivirus makes every launch slow.
// Per file it counts uses of the launch APIs and of the repo's synchronous wrappers around them.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const BASELINE_PATH = 'config/main-sync-spawn-baseline.txt'
const SCAN_DIRECTORIES = ['src/main', 'src/shared']
const PROCESS_ADVICE = 'use runProcess or spawnProcess from @orca/process-host'
const SECURE_ADVICE = `rewrites a DACL on the calling thread, and a directory rewrite blocks on its whole subtree; use restrictWindowsDirectory for a directory, or raise this file's count in ${BASELINE_PATH} (or add a row)`
// Gated modules (package names, or repo-relative paths without extension, re-exporters included)
// and the advice for each gated function they export.
const GATED_FAMILIES = [
  {
    modules: ['child_process', 'node:child_process'],
    advice: { execFileSync: PROCESS_ADVICE, spawnSync: PROCESS_ADVICE, execSync: PROCESS_ADVICE }
  },
  { modules: ['@orca/process-host'], advice: { runProcessSync: PROCESS_ADVICE } },
  {
    modules: ['src/shared/secure-path-windows-acl'],
    advice: { restrictWindowsPathSync: SECURE_ADVICE }
  },
  {
    modules: ['src/main/git/command-runner/git-exec-file', 'src/main/git/runner'],
    advice: { gitExecFileSync: 'use gitExecFileAsync' }
  },
  {
    modules: ['src/main/wsl'],
    advice: {
      getWslHome: 'use getWslHomeAsync',
      listWslDistros: 'use listWslDistrosAsync',
      wslUncDirectoryExists: 'use wslUncDirectoryExistsAsync'
    }
  },
  {
    modules: ['src/main/wsl-availability', 'src/main/wsl'],
    advice: { isWslAvailable: 'use isWslAvailableAsync' }
  },
  { modules: ['src/main/pwsh'], advice: { isPwshAvailable: 'use isPwshAvailableAsync' } },
  { modules: ['src/main/win32-utils'], advice: { grantDirAcl: 'use grantDirAclAsync' } }
]
const ADVICE = new Map(GATED_FAMILIES.flatMap((family) => Object.entries(family.advice)))
const GATED_MARKERS = [
  ...ADVICE.keys(),
  ...new Set(
    GATED_FAMILIES.flatMap((family) => family.modules.map((module) => path.posix.basename(module)))
  )
]
const FALLBACK_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken])
const BASELINE_HEADER = [
  '# Synchronous child-process launches in production src/main and src/shared, per file: uses of',
  '# execFileSync/spawnSync/execSync, runProcessSync and the repo sync wrappers listed in',
  '# config/scripts/check-main-sync-spawn-ratchet.mjs (synchronous ACL rewrites and grants, which',
  '# can block on a whole directory subtree).',
  '# Some entries run in the daemon or orcad process, or are test harnesses outside the test-path',
  '# conventions. This is a RATCHET: counts may only go DOWN.',
  '# Prune after removing launches: pnpm check:main-sync-spawn-ratchet --prune'
]

function normalized(file) {
  return file.replaceAll('\\', '/')
}

function moduleKey(file) {
  return normalized(file).replace(/\.[cm]?[jt]sx?$/, '')
}

function symbolsOf(key) {
  const names = GATED_FAMILIES.filter((family) => family.modules.includes(key)).flatMap((family) =>
    Object.keys(family.advice)
  )
  return names.length > 0 ? new Set(names) : null
}

/** Gated functions a module specifier exports, or null when the module is not gated. */
export function gatedSymbolsFor(file, specifier) {
  const normalizedSpecifier = normalized(specifier)
  if (!normalizedSpecifier.startsWith('.')) {
    return symbolsOf(normalizedSpecifier)
  }
  return symbolsOf(
    moduleKey(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(normalized(file)), normalizedSpecifier)
      )
    )
  )
}

function isValueReference(node) {
  const parent = node.parent
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return false
  }
  if (ts.isExportSpecifier(parent)) {
    return !parent.parent.parent.moduleSpecifier && node === (parent.propertyName ?? parent.name)
  }
  if (ts.isBindingElement(parent)) {
    return node === parent.initializer
  }
  return (
    ts.isShorthandPropertyAssignment(parent) ||
    (parent.name !== node && parent.propertyName !== node && parent.label !== node)
  )
}

/**
 * Every value reference to a gated function counts (call, hand-off, alias initializer, each alias
 * use), plus each re-export and a gated module's own references; imports alone count nothing.
 * File-wide, not scope-aware; computed specifiers and member names are not resolved.
 * Counted by reference only: not traced through non-const holders or the file's own wrappers.
 */
export function collectSyncLaunchUses(file, contents) {
  // Escaped spellings and relative imports inside gated modules still need the full analysis.
  const analyze =
    contents.includes('\\') ||
    GATED_MARKERS.some((marker) => contents.includes(marker) || file.includes(marker))
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, analyze)
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${file}; the sync-spawn ratchet must not skip it.`)
  }
  if (!analyze) {
    return { count: 0, symbols: [] }
  }
  const used = new Set()
  let count = 0
  const namespaces = new Map()
  // Local name -> gated function it refers to.
  const functions = new Map([...(symbolsOf(moduleKey(file)) ?? [])].map((name) => [name, name]))
  const aliases = []
  const members = []
  const identifiers = []
  const destructures = []

  function moduleSymbols(node) {
    node = unwrap(node)
    if (!node) {
      return null
    }
    if (ts.isIdentifier(node)) {
      return namespaces.get(node.text) ?? null
    }
    const loads =
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    const specifier = loads ? literalString(node.arguments[0]) : null
    return specifier === null ? null : gatedSymbolsFor(file, specifier)
  }
  function gatedFunction(node) {
    node = unwrap(node)
    if (!node) {
      return null
    }
    if (ts.isIdentifier(node)) {
      return functions.get(node.text) ?? null
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node)
      return moduleSymbols(node.expression)?.has(name) ? name : null
    }
    if (ts.isConditionalExpression(node)) {
      return gatedFunction(node.whenTrue) ?? gatedFunction(node.whenFalse)
    }
    if (ts.isBinaryExpression(node) && FALLBACK_OPERATORS.has(node.operatorToken.kind)) {
      return gatedFunction(node.left) ?? gatedFunction(node.right)
    }
    return null
  }
  function recordUse(name) {
    used.add(name)
    count += 1
  }
  function visitImport(node) {
    const symbols = gatedSymbolsFor(file, node.moduleSpecifier.text)
    const clause = node.importClause
    if (!symbols || !clause || clause.isTypeOnly) {
      return
    }
    if (clause.name) {
      namespaces.set(clause.name.text, symbols)
    }
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) {
      namespaces.set(named.name.text, symbols)
    }
    for (const element of named && ts.isNamedImports(named) ? named.elements : []) {
      const imported = (element.propertyName ?? element.name).text
      if (!element.isTypeOnly && symbols.has(imported)) {
        functions.set(element.name.text, imported)
      }
    }
  }
  function visitExport(node) {
    const symbols =
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly
        ? gatedSymbolsFor(file, node.moduleSpecifier.text)
        : null
    if (!symbols) {
      return
    }
    const names =
      !node.exportClause || ts.isNamespaceExport(node.exportClause)
        ? [...symbols]
        : node.exportClause.elements
            .filter((element) => !element.isTypeOnly)
            .map((element) => (element.propertyName ?? element.name).text)
    for (const name of names.filter((name) => symbols.has(name))) {
      used.add(name)
      count += 1
    }
  }
  function visit(node) {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
      return
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      visitImport(node)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const symbols = gatedSymbolsFor(file, node.moduleReference.expression.text)
      if (symbols) {
        namespaces.set(node.name.text, symbols)
      }
    } else if (ts.isExportDeclaration(node)) {
      visitExport(node)
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      members.push(node)
    } else if (ts.isIdentifier(node) && isValueReference(node)) {
      identifiers.push(node)
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        aliases.push({ name: node.name.text, initializer: node.initializer })
      } else if (ts.isObjectBindingPattern(node.name)) {
        destructures.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  // Aliases can chain (`const cp = require('child_process'); const run = cp.execFileSync`).
  for (let changed = true; changed;) {
    changed = false
    for (const { name, initializer } of aliases) {
      const symbols = moduleSymbols(initializer)
      const gated = symbols ? null : gatedFunction(initializer)
      if (symbols && !namespaces.has(name)) {
        namespaces.set(name, symbols)
        changed = true
      } else if (gated && !functions.has(name)) {
        functions.set(name, gated)
        changed = true
      }
    }
    for (const node of destructures) {
      const symbols = moduleSymbols(node.initializer)
      for (const element of symbols ? node.name.elements : []) {
        const key = element.propertyName ?? element.name
        const name = ts.isIdentifier(key) ? key.text : literalString(key)
        if (
          symbols.has(name) &&
          ts.isIdentifier(element.name) &&
          !functions.has(element.name.text)
        ) {
          functions.set(element.name.text, name)
          changed = true
        }
      }
    }
  }
  for (const node of members) {
    const name = propertyName(node)
    if (moduleSymbols(node.expression)?.has(name)) {
      recordUse(name)
    }
  }
  for (const node of identifiers) {
    const name = functions.get(node.text)
    if (name) {
      recordUse(name)
    }
  }
  return { count, symbols: [...used].sort() }
}

export function isRatchetedSourcePath(file) {
  return (
    SCAN_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)) &&
    !file.endsWith('.d.ts') &&
    !isTestOnlySourcePath(file)
  )
}

/** Per-file use counts and the gated functions each file uses. */
export function countSyncSpawnUses(sources) {
  const counts = new Map()
  const symbols = new Map()
  for (const [file, contents] of sources) {
    if (!isRatchetedSourcePath(file)) {
      continue
    }
    const uses = collectSyncLaunchUses(file, contents)
    if (uses.count > 0) {
      counts.set(file, uses.count)
      symbols.set(file, uses.symbols)
    }
  }
  return { counts, symbols }
}

export function adviceFor(symbols) {
  const groups = new Map()
  for (const symbol of symbols) {
    groups.set(ADVICE.get(symbol), [...(groups.get(ADVICE.get(symbol)) ?? []), symbol])
  }
  return [...groups].map(([advice, names]) => `${names.join(', ')}: ${advice}.`).join(' ')
}

export function collectSyncSpawnSources(root = ROOT) {
  return new Map(
    globSync(
      SCAN_DIRECTORIES.map((directory) => `${directory}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`),
      { cwd: root, exclude: ['**/node_modules/**'] }
    )
      .map(normalized)
      .filter(isRatchetedSourcePath)
      .sort()
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')])
  )
}

export function main(root = ROOT) {
  const { counts, symbols } = countSyncSpawnUses(collectSyncSpawnSources(root))
  const { grown, shrunk } = diffCounts(
    counts,
    parseCountBaseline(readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
  )
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${now} synchronous launch use(s), baseline allows ${allowed}. They block the main thread. ${adviceFor(symbols.get(file))}`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${now} synchronous launch use(s), baseline still allows ${allowed}. Run: pnpm check:main-sync-spawn-ratchet --prune`
    )
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(
    `Main sync-spawn ratchet OK — ${totalCount(counts)} use(s) in ${counts.size} legacy file(s).`
  )
  return 0
}

export function prune(root = ROOT) {
  const { counts } = countSyncSpawnUses(collectSyncSpawnSources(root))
  const kept = pruneCountBaseline(root, BASELINE_PATH, BASELINE_HEADER, counts)
  console.log(`Pruned ${BASELINE_PATH} to ${kept} use(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--prune') {
    prune()
  }
  process.exitCode = main()
}
