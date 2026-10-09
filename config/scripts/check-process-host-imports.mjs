import { globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PACKAGE_NAME = '@orca/process-host'
const PACKAGE_DIRECTORY = 'src/packages/process-host'
const PACKAGE_SOURCE = `${PACKAGE_DIRECTORY}/src/`
const BASELINE_PATH = 'config/process-host-direct-import-baseline.txt'
const SOURCE_PATTERNS = [
  '*.{ts,tsx,mts,cts,js,mjs,cjs}',
  ...['src', 'config', 'tests', 'mobile/src', 'mobile/app', 'mobile/scripts'].map(
    (directory) => `${directory}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`
  )
]

function normalized(file) {
  return file.split(path.sep).join('/')
}

export function collectModuleSpecifiers(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${file}; the process-host import check must not skip it.`)
  }
  const specifiers = new Set()
  function literal(node) {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.add(node.text)
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal(node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'require' &&
          callee.name.text === 'resolve')
      ) {
        literal(node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...specifiers]
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function publicEntry(specifier, manifest) {
  const subpath = specifier === PACKAGE_NAME ? '.' : `.${specifier.slice(PACKAGE_NAME.length)}`
  return Object.hasOwn(manifest.exports ?? {}, subpath)
}

function packageRelativeImport(file, specifier) {
  if (!specifier.startsWith('.')) {
    return null
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
}

export function assessProcessHostImports(sources, manifest, baseline) {
  const direct = new Set()
  const violations = []
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ])
  for (const [file, contents] of sources) {
    const ownSource = file.startsWith(PACKAGE_SOURCE)
    for (const specifier of collectModuleSpecifiers(file, contents)) {
      const local = packageRelativeImport(file, specifier)
      const selfImport = specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)
      const testCorpusImport =
        isTestOnlySourcePath(file) && local?.startsWith(`${PACKAGE_SOURCE}__fixtures__/`)
      if (selfImport && !publicEntry(specifier, manifest)) {
        violations.push(`${file}: ${specifier} is not a public process-host export`)
      }
      if (!ownSource && !testCorpusImport && local?.startsWith(`${PACKAGE_DIRECTORY}/`)) {
        violations.push(`${file}: import process-host through ${PACKAGE_NAME}, not ${specifier}`)
      }
      if (ownSource) {
        if (local !== null && !local.startsWith(PACKAGE_SOURCE)) {
          violations.push(`${file}: process-host cannot import outside its source: ${specifier}`)
        } else if (path.isAbsolute(specifier)) {
          violations.push(`${file}: process-host cannot import an absolute path: ${specifier}`)
        } else if (
          local === null &&
          !selfImport &&
          !isBuiltin(specifier) &&
          !dependencies.has(packageName(specifier)) &&
          !(
            isTestOnlySourcePath(file) &&
            Object.hasOwn(manifest.devDependencies ?? {}, packageName(specifier))
          )
        ) {
          violations.push(`${file}: undeclared process-host dependency: ${specifier}`)
        }
      } else if (
        file.startsWith('src/') &&
        !isTestOnlySourcePath(file) &&
        (specifier === 'child_process' || specifier === 'node:child_process')
      ) {
        direct.add(file)
      }
    }
  }
  const current = [...direct].sort()
  const baselineSet = new Set(baseline)
  return {
    direct: current,
    added: current.filter((file) => !baselineSet.has(file)),
    stale: baseline.filter((file) => !direct.has(file)).sort(),
    violations: violations.sort()
  }
}

export function readProcessHostBaseline(contents) {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export function collectProcessHostSources(root = ROOT) {
  return new Map(
    globSync(SOURCE_PATTERNS, {
      cwd: root,
      exclude: ['**/node_modules/**', '**/.*/**', '**/dist/**', '**/out/**', '**/build/**']
    })
      .map(normalized)
      .sort()
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')])
  )
}

export function main(root = ROOT) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, PACKAGE_DIRECTORY, 'package.json'), 'utf8')
  )
  const baseline = readProcessHostBaseline(readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
  const sources = collectProcessHostSources(root)
  if (
    ![...sources.keys()].some(
      (file) => file.startsWith(PACKAGE_SOURCE) && !isTestOnlySourcePath(file)
    )
  ) {
    throw new Error(`Missing process-host implementation under ${PACKAGE_SOURCE}`)
  }
  const result = assessProcessHostImports(sources, manifest, baseline)
  const failures = [
    ...result.violations,
    ...result.added.map((file) => `${file}: new direct child_process import; use ${PACKAGE_NAME}`),
    ...result.stale.map((file) => `${file}: remove stale direct-import baseline entry`)
  ]
  if (failures.length > 0) {
    console.error(`[process-host-imports]\n${failures.join('\n')}`)
    return 1
  }
  console.log(`[process-host-imports] ok; ${result.direct.length} legacy direct importers remain`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
