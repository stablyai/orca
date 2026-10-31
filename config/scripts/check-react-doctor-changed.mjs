import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { collectAddedLineRanges, overlapsAddedLines } from './check-changed-code-quality.mjs'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { runAuditTool } from './run-audit-tool.mjs'

const SOURCE_FILE_PATTERN = /\.(?:astro|tsx?|jsx?|mts|mjs|[hH][tT][mM][lL])$/

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function reportPath(root, file, directory = root) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('React Doctor returned an invalid file path.')
  }
  const absolute = file.startsWith('file://')
    ? fileURLToPath(file)
    : path.resolve(directory, file.replaceAll('\\', '/'))
  const canonical = realpathSync(absolute)
  const relative = path.relative(root, canonical)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('React Doctor returned a path outside the report root.')
  }
  return canonical
}

function readCompleteDiagnostics(stdout, root, comparisonBase) {
  const report = JSON.parse(stdout)
  if (
    report?.schemaVersion !== 3 ||
    report.ok !== true ||
    report.error !== null ||
    report.mode !== 'diff' ||
    report.baselineDegraded ||
    typeof report.version !== 'string' ||
    report.version.length === 0 ||
    !Number.isFinite(report.elapsedMilliseconds) ||
    report.elapsedMilliseconds < 0 ||
    !path.isAbsolute(report.directory ?? '') ||
    reportPath(root, report.directory) !== root ||
    report.diff?.baseBranch !== comparisonBase ||
    !(report.diff.currentBranch === null || typeof report.diff.currentBranch === 'string') ||
    !isCount(report.diff.changedFileCount) ||
    typeof report.diff.isCurrentChanges !== 'boolean' ||
    !Array.isArray(report.projects) ||
    !Array.isArray(report.diagnostics) ||
    (report.skippedProjects !== undefined &&
      (!Array.isArray(report.skippedProjects) || report.skippedProjects.length > 0))
  ) {
    throw new Error('React Doctor did not return a complete diff report.')
  }
  const diagnostics = []
  const flattened = []
  const analyzedPaths = new Set()
  let affectedFiles = 0
  for (const project of report.projects) {
    if (
      project?.complete !== true ||
      !path.isAbsolute(project.directory ?? '') ||
      !path.isAbsolute(project.packageRoot ?? '') ||
      !Array.isArray(project.diagnostics) ||
      !Array.isArray(project.skippedChecks) ||
      project.skippedChecks.length > 0 ||
      (project.skippedCheckReasons !== undefined &&
        (!project.skippedCheckReasons ||
          typeof project.skippedCheckReasons !== 'object' ||
          Array.isArray(project.skippedCheckReasons) ||
          Object.keys(project.skippedCheckReasons).length > 0)) ||
      !Array.isArray(project.analyzedFiles) ||
      !isCount(project.analyzedFileCount) ||
      project.analyzedFileCount !== project.analyzedFiles.length ||
      !isCount(project.scannedFileCount) ||
      project.scannedFileCount !== project.analyzedFileCount
    ) {
      throw new Error('React Doctor returned incomplete project coverage.')
    }
    reportPath(root, project.directory)
    const packageRoot = reportPath(root, project.packageRoot)
    const analyzedFiles = new Set(
      project.analyzedFiles.map((file) => reportPath(root, file, packageRoot))
    )
    if (analyzedFiles.size !== project.analyzedFileCount) {
      throw new Error('React Doctor returned duplicate analyzed paths.')
    }
    for (const file of analyzedFiles) {
      analyzedPaths.add(file)
    }
    const diagnosedFiles = new Set()
    for (const diagnostic of project.diagnostics) {
      if (
        !['filePath', 'normalizedFilePath', 'id', 'plugin', 'rule', 'message'].every(
          (field) => typeof diagnostic?.[field] === 'string' && diagnostic[field].length > 0
        ) ||
        !['error', 'warning'].includes(diagnostic.severity) ||
        !isCount(diagnostic.line) ||
        !isCount(diagnostic.column) ||
        (diagnostic.endLine !== undefined &&
          (!isCount(diagnostic.endLine) || diagnostic.endLine < diagnostic.line)) ||
        ['offset', 'length', 'endColumn'].some(
          (field) => diagnostic[field] !== undefined && !isCount(diagnostic[field])
        )
      ) {
        throw new Error('React Doctor returned an invalid diagnostic identity or span.')
      }
      const absolute = reportPath(root, diagnostic.filePath, packageRoot)
      const normalized = path.relative(packageRoot, absolute).split(path.sep).join('/')
      const file = path.relative(root, absolute).split(path.sep).join('/')
      const digest = createHash('sha256')
        .update(JSON.stringify([diagnostic.severity, diagnostic.message]))
        .digest('hex')
      const identity = `${file}::${diagnostic.line}:${diagnostic.column}::${diagnostic.plugin}/${diagnostic.rule}::${digest}`
      if (
        diagnostic.normalizedFilePath !== normalized ||
        diagnostic.id !== identity ||
        !analyzedFiles.has(absolute)
      ) {
        throw new Error('React Doctor returned inconsistent diagnostic paths or coverage.')
      }
      diagnosedFiles.add(normalized)
      diagnostics.push({ diagnostic, file })
      flattened.push(diagnostic)
    }
    affectedFiles += diagnosedFiles.size
  }
  const summary = report.summary
  if (
    !isDeepStrictEqual(report.diagnostics, flattened) ||
    analyzedPaths.size > report.diff.changedFileCount ||
    !summary ||
    summary.totalDiagnosticCount !== flattened.length ||
    summary.errorCount !==
      flattened.filter((diagnostic) => diagnostic.severity === 'error').length ||
    summary.warningCount !==
      flattened.filter((diagnostic) => diagnostic.severity === 'warning').length ||
    summary.affectedFileCount !== affectedFiles
  ) {
    throw new Error('React Doctor returned inconsistent diagnostics or summary counts.')
  }
  return diagnostics
}

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--') ??
    process.env.ORCA_CODE_QUALITY_BASE ??
    'origin/main',
  run = runAuditTool
) {
  root = realpathSync(root)
  const base = resolvePullRequestDiffBase(root, requestedBase)
  // Accept revision syntax, never shell fragments or option injection.
  if (!/^(?!-)[A-Za-z0-9._/@^~-]+$/.test(base)) {
    throw new Error(`Refusing to pass an unsafe diff base to React Doctor: ${base}`)
  }
  const { comparisonBase, rangesByFile } = collectAddedLineRanges(root, base, {
    includePath: (file) => SOURCE_FILE_PATTERN.test(file)
  })
  const result = run(
    'react-doctor',
    [
      '.',
      '--yes',
      '--scope',
      'files',
      '--base',
      comparisonBase,
      '--include-untracked',
      '--no-dead-code',
      '--no-supply-chain',
      '--no-telemetry',
      '--blocking',
      'none',
      '--json'
    ],
    { root, stdio: 'pipe' }
  )
  if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
    throw new Error(`React Doctor scan failed: ${result.stderr || result.signal || result.code}`)
  }
  const diagnostics = readCompleteDiagnostics(result.stdout, root, comparisonBase)
  let failures = 0
  for (const { diagnostic, file } of diagnostics) {
    const ranges = rangesByFile.get(file)
    if (
      diagnostic.severity === 'error' &&
      ranges &&
      (diagnostic.line === 0 ||
        overlapsAddedLines(diagnostic.line, diagnostic.endLine ?? diagnostic.line, ranges))
    ) {
      console.error(
        `${file}:${diagnostic.line} ${diagnostic.plugin}/${diagnostic.rule}: ${diagnostic.message}`
      )
      failures += 1
    }
  }
  console.log(`React Doctor changed-lines gate: ${failures} error(s).`)
  return failures > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
