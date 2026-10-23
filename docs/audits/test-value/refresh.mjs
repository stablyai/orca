import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript-api'
import { discoverUnitFiles } from '../../../config/scripts/ci-unit-files.mjs'

const directory = import.meta.dirname
const root = resolve(directory, '../../..')
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const digest = (source) => createHash('sha256').update(source).digest('hex')
const tracked = git('ls-files', '-z').split('\0').filter(Boolean).sort()
const trackedSet = new Set(tracked)
const unit = new Set(discoverUnitFiles(root))
const reviews = new Map()
const errors = []
const decisions = new Set(['keep', 'remove', 'consolidate', 'fix'])

function testRoot(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return testRoot(expression.expression)
  }
  if (ts.isElementAccessExpression(expression)) {
    return testRoot(expression.expression)
  }
  if (ts.isCallExpression(expression)) {
    return testRoot(expression.expression)
  }
  return ''
}

function declarations(path, source) {
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const names = new Set(['it', 'test', 'fit', 'xit', 'xtest', 'ftest'])
    const cases = []
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node)) {
        continue
      }
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        /^(node:test|tape|ava)$/.test(node.moduleSpecifier.text) &&
        node.importClause?.name
      ) {
        names.add(node.importClause.name.text)
      }
      const bindings = node.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue
      }
      for (const binding of bindings.elements) {
        if (names.has(binding.propertyName?.text ?? binding.name.text)) {
          names.add(binding.name.text)
        }
      }
    }
    function visit(node) {
      if (ts.isCallExpression(node) && names.has(testRoot(node.expression))) {
        const title = node.arguments[0]
        const expression = node.expression.getText(tree)
        if (
          title &&
          node.arguments.length >= 2 &&
          !/\.(step|extend|use|setTimeout|configure|info)\b/.test(expression) &&
          (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))
        ) {
          cases.push({
            line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            title: ts.isStringLiteralLike(title) ? title.text : title.getText(tree)
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    return cases
  }
  const patterns = {
    rs: /#\[(?:(?:\w+::)?test|rstest)(?:\([^\]]*\))?\][\s\S]*?\bfn\s+(\w+)/g,
    py: /^[ \t]*(?:async\s+)?def\s+(test_\w+)\s*\(/gm,
    rb: /^[ \t]*(?:def\s+(test_\w+)|test\s+['"]([^'"]+))/gm,
    swift: /^[ \t]*(?:func\s+(test\w+)\s*\(|@Test\b[^\n]*\n\s*(?:@\w+[^\n]*\n\s*)*func\s+(\w+))/gm,
    kt: /@(?:Test|ParameterizedTest)\b[^\n]*\n\s*fun\s+(`[^`]+`|\w+)/g,
    go: /^func\s+(Test\w+)\s*\(/gm,
    ps1: /^[ \t]*It\s+['"]([^'"]+)/gim
  }
  const pattern = patterns[path.split('.').at(-1)]
  return pattern
    ? [...source.matchAll(pattern)].map((match) => ({
        line: source.slice(0, match.index).split('\n').length,
        title: match.slice(1).find(Boolean)
      }))
    : []
}

for (const name of readdirSync(resolve(directory, 'reviews'))
  .filter((name) => name.endsWith('.jsonl'))
  .sort()) {
  const rows = readFileSync(resolve(directory, 'reviews', name), 'utf8')
    .trim()
    .split('\n')
  for (const line of rows.filter(Boolean)) {
    const review = JSON.parse(line)
    const label = `${name}:${review.path}`
    if (!review.rationale || !review.evidence?.length || !review.reviewer) {
      errors.push(`${label}: missing evidence`)
    }
    if (
      !review.sha256 ||
      (review.decision !== 'remove' && !review.reviewed_sha256) ||
      !review.source_commit
    ) {
      errors.push(`${label}: missing hash or source commit`)
    }
    if (!Array.isArray(review.cases)) {
      errors.push(`${label}: missing case decisions`)
    }
    for (const entry of review.cases ?? []) {
      if (!entry.line || !entry.title || !entry.reason || !decisions.has(entry.decision)) {
        errors.push(`${label}: invalid case decision`)
      }
    }
    if (review.source_commit && review.sha256) {
      const original = git('show', `${review.source_commit}:${review.path}`)
      if (digest(original) !== review.sha256) {
        errors.push(`${label}: original content hash mismatch`)
      }
      const expected = declarations(review.path, original)
      const recorded = new Set((review.cases ?? []).map((entry) => entry.line))
      for (const entry of expected) {
        if (!recorded.has(entry.line)) {
          errors.push(`${label}:${entry.line}: missing decision for ${entry.title}`)
        }
      }
    }
    const previous = reviews.get(review.path)
    if (previous && previous.batch === name) {
      errors.push(`${label}: duplicate review`)
    }
    reviews.set(review.path, { ...review, batch: name })
  }
}

const rows = []
const counts = { files: 0, declarations: 0, reviewed: 0, stale: 0, unreviewed: 0, removed: 0 }
const areas = {}
let scanned = 0
for (const path of tracked) {
  if (path.startsWith('docs/audits/test-value/')) {
    continue
  }
  if (
    !/\.(?:[cm]?[jt]sx?|rs|py|rb|swift|kt|go|ps1|sh|bash|zsh|fish|c|cc|cpp|h)$/.test(path) &&
    !reviews.has(path)
  ) {
    continue
  }
  scanned++
  if (!existsSync(resolve(root, path))) {
    if (reviews.get(path)?.decision !== 'remove') {
      errors.push(`${path}: deleted without a reviewed removal decision`)
    }
    continue
  }
  const source = readFileSync(resolve(root, path), 'utf8')
  const named =
    /(?:\.(?:test|tests|spec|e2e)\.|(?:^|\/)test_[^/]+$|_test\.[^/]+$|(?:Tests|Checks)\.swift$|Test\.kt$)/.test(
      path
    )
  const auxiliary =
    /(?:^|\/)(?:tests?|__tests__|__fixtures__|test-support|fixtures?|benches|benchmarks|repros?)(?:\/|[-.])|(?:^|[/.-])(?:test-fixtures?|repro\w*|regression\w*|benchmark\w*|bench|smoke)(?:[.-]|$)/i.test(
      path
    )
  const cases = declarations(path, source)
  if (!named && !auxiliary && !cases.length && !reviews.has(path)) {
    continue
  }
  const sha256 = digest(source)
  const review = reviews.get(path)
  const status = review ? (review.reviewed_sha256 === sha256 ? 'reviewed' : 'stale') : 'unreviewed'
  const signals = [
    named && 'named',
    cases.length && 'declarations',
    auxiliary && 'auxiliary',
    unit.has(path) && 'ci-unit'
  ].filter(Boolean)
  rows.push({
    path,
    sha256,
    declarations: cases.length,
    signals,
    status,
    ...(review ? { review: `reviews/${review.batch}` } : {})
  })
  counts.files++
  counts.declarations += cases.length
  counts[status]++
  const area = path.startsWith('src/') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0]
  areas[area] ??= { files: 0, reviewed: 0, stale: 0, unreviewed: 0 }
  areas[area].files++
  areas[area][status]++
}
for (const [path, review] of reviews) {
  if (trackedSet.has(path) && existsSync(resolve(root, path))) {
    continue
  }
  if (review.decision !== 'remove') {
    errors.push(`${path}: reviewed file is absent without a removal decision`)
  }
  rows.push({ path, sha256: review.sha256, status: 'removed', review: `reviews/${review.batch}` })
  counts.removed++
}
const progress = {
  source_commit: git('rev-parse', 'HEAD').trim(),
  scanned_source_files: scanned,
  counts,
  reviewed_original_declarations: [...reviews.values()].reduce(
    (sum, review) => sum + (review.cases?.length ?? 0),
    0
  ),
  areas,
  errors
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  writeFileSync(
    resolve(directory, 'inventory.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  )
  writeFileSync(resolve(directory, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`)
  console.log(JSON.stringify(progress, null, 2))
}
