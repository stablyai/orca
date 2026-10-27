import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { scanAstGrep } from './ast-grep-scan.mjs'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/
const ROOT_CODE_QUALITY_IGNORED_PREFIXES = ['cloud/']
const CASTING_RULE = 'typescript/consistent-type-assertions'
const CASTING_DISABLE_PATTERN =
  /\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s[^\n]*typescript\/consistent-type-assertions/
const ANTI_SLOP_DISABLE_PATTERN =
  /\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s[^\n]*\banti-slop\//
const REACT_DOCTOR_DISABLE_PATTERN =
  /^\s*\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s+react-doctor\/[\w-]+(?:\s*,\s*react-doctor\/[\w-]+)*\s*(?:--(?:(?!\*\/).)*)?(?:\*\/)?\s*$/
const JS_PLUGINS_CONFIG = 'config/oxlint-js-plugins.json'
// The root scan no longer loads these plugins, so their suppressions belong to the JS plugins scan.
const JS_PLUGIN_NAMES = JSON.parse(
  readFileSync(new URL(`../../${JS_PLUGINS_CONFIG}`, import.meta.url), 'utf8')
).jsPlugins.map((plugin) => plugin.name)
const JS_PLUGIN_DISABLE_PATTERN = new RegExp(
  String.raw`\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s[^\n]*\b(?:${JS_PLUGIN_NAMES.join('|')})\/`
)
const EXPLICIT_DISABLE_RULE_PATTERN = /(?:-disable(?:-next-line|-line)?\s+|^)[\w-]+(?:\/[\w-]+)?/
export const OXLINT_SCANS = [
  {
    // Leave config discovery enabled so mobile’s nested config can disable root rules.
    label: 'code quality',
    args: ['--report-unused-disable-directives-severity', 'warn']
  },
  {
    // Keep JS plugins in gates: transferring every AST to Node slows the default native scan.
    label: 'JS plugins',
    args: ['--config', JS_PLUGINS_CONFIG]
  },
  {
    label: 'casting code quality',
    args: ['--config', 'config/oxlint-code-quality-casting.json']
  },
  {
    // CI native audit runs before mobile install and cannot see its cycles; keep local changed gate aligned.
    label: 'focused plugins',
    args: [
      '--config',
      'config/oxlint-code-quality-native-plugins.json',
      '--allow',
      'import/no-cycle'
    ]
  },
  {
    label: 'type-aware code quality',
    args: ['--type-aware', '--config', 'config/oxlint-code-quality-type-aware.json']
  },
  {
    label: 'React Doctor',
    args: [
      '--config',
      'config/oxlint-react-doctor.json',
      '--report-unused-disable-directives-severity',
      'warn'
    ]
  },
  {
    // Gate added lines against existing renderer design debt (~4.7k findings).
    label: 'design system',
    args: ['--config', 'config/oxlint-design-system.json']
  }
]

const SUPPRESSED_REACT_DOCTOR_DIAGNOSTICS = new Map([
  [
    'react-doctor(no-adjust-state-on-prop-change)',
    new Set([
      'src/renderer/src/components/task-page/github/use-task-page-github-issue-draft.ts',
      'src/renderer/src/components/use-task-page-jira-creation-state.ts'
    ])
  ],
  [
    'react-doctor(no-derived-state-effect)',
    new Set([
      'src/renderer/src/components/editor/combined-diff/review-controls/use-combined-diff-view-preferences.ts',
      // The open-cycle reset effect predates this entry; it surfaced when its body changed.
      'src/renderer/src/components/right-sidebar/useSourceControlAgentActionDialog.ts'
    ])
  ],
  [
    // Existing timer effects clean variable handle sets through addTimer; rule expects one named handle and falsely reports both.
    // Exemption is per-file, covering those two effects; this file has no other timer effects.
    'react-doctor(effect-needs-cleanup)',
    new Set(['mobile/src/session/use-mobile-session-startup.ts'])
  ]
])

export function parseAddedLineRanges(diff) {
  const ranges = []
  const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
  for (const line of diff.split(/\r?\n/)) {
    const match = hunkPattern.exec(line)
    if (!match) {
      continue
    }
    const start = Number.parseInt(match[1], 10)
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 })
    }
  }
  return ranges
}

export function overlapsAddedLines(startLine, endLine, ranges) {
  return ranges.some((range) => startLine <= range.end && endLine >= range.start)
}

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

export function isRootCodeQualityPath(file) {
  return !ROOT_CODE_QUALITY_IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix))
}

function resolveBase(root, requestedBase) {
  for (const candidate of [
    requestedBase,
    process.env.ORCA_CODE_QUALITY_BASE,
    'origin/main',
    'main'
  ]) {
    if (!candidate) {
      continue
    }
    const result = spawnSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
    if (result.status === 0) {
      return candidate
    }
  }
  throw new Error('Pass the pull request base SHA or make origin/main available locally.')
}

export function collectAddedLineRanges(
  root,
  requestedBase,
  { includePath = (file) => isRootCodeQualityPath(file) && SOURCE_FILE_PATTERN.test(file) } = {}
) {
  // PR checkout HEAD is the merge commit: first parent identifies base without shallow-clone missing payload ancestry.
  // Local branch tips still need merge-base to isolate their changes.
  const comparisonBase =
    resolvePullRequestDiffBase(root, null) ??
    runGit(root, ['merge-base', resolveBase(root, requestedBase), 'HEAD']).trim()
  const changedEntries = splitNullDelimited(
    runGit(root, ['diff', '--name-status', '--find-renames', '-z', comparisonBase, '--'])
  )
  const changedFiles = []
  const renamedSources = new Map()
  for (let index = 0; index < changedEntries.length;) {
    const status = changedEntries[index++]
    const source = changedEntries[index++]
    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = changedEntries[index++]
      changedFiles.push(destination)
      if (status.startsWith('R') && includePath(source)) {
        renamedSources.set(destination, source)
      }
    } else if (status !== 'D') {
      changedFiles.push(source)
    }
  }
  const untrackedFiles = splitNullDelimited(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  const rangesByFile = new Map()

  for (const file of changedFiles) {
    if (!includePath(file) || !existsSync(path.join(root, file))) {
      continue
    }
    const source = renamedSources.get(file)
    const paths = source ? [source, file] : [file]
    const diff = runGit(root, [
      'diff',
      '--find-renames',
      '--unified=0',
      '--no-color',
      comparisonBase,
      '--',
      ...paths
    ])
    const ranges = parseAddedLineRanges(diff)
    if (ranges.length > 0) {
      rangesByFile.set(file, ranges)
    }
  }

  for (const file of untrackedFiles) {
    const absolutePath = path.join(root, file)
    if (!includePath(file) || !existsSync(absolutePath)) {
      continue
    }
    const lineCount = readFileSync(absolutePath, 'utf8').split(/\r?\n/).length
    rangesByFile.set(file, [{ start: 1, end: lineCount }])
  }
  return { comparisonBase, rangesByFile }
}

function parseOxlintOutput(stdout, label) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error(`${label} did not return Oxlint JSON output.`)
  }
  return JSON.parse(stdout.slice(start, end + 1))
}

function normalizedDiagnosticPath(root, filename) {
  const absolutePath = path.isAbsolute(filename) ? filename : path.join(root, filename)
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

function diagnosticLineRange(root, filename, span) {
  const startLine = span.line
  if (!Number.isInteger(startLine)) {
    return null
  }
  if (!Number.isInteger(span.offset) || !Number.isInteger(span.length) || span.length === 0) {
    return { start: startLine, end: startLine }
  }
  const absolutePath = path.isAbsolute(filename) ? filename : path.join(root, filename)
  const source = readFileSync(absolutePath)
  const highlighted = source.subarray(span.offset, span.offset + span.length).toString('utf8')
  return { start: startLine, end: startLine + (highlighted.match(/\n/g)?.length ?? 0) }
}

// Split files mark moved code added; exempt diagnostic blocks already verbatim/contiguous in touched base files to avoid demanding unrelated edits.
function normalizeSourceLine(line) {
  return line.replace(/\s+/g, ' ').trim()
}

function readBaseSourceBatch(root, comparisonBase, files) {
  // Git 2.25 supports --batch; its newline protocol cannot represent newline paths.
  if (files.some((file) => /[\r\n]/.test(`${comparisonBase}:${file}`))) {
    return null
  }
  try {
    const result = runProcessSync({
      program: 'git',
      args: ['cat-file', '--batch'],
      cwd: root,
      input: files.map((file) => `${comparisonBase}:${file}\n`).join(''),
      captureStdoutAsBytes: true,
      maxOutputBytes: 64 * 1024 * 1024,
      timeoutMs: null
    })
    if (result.code !== 0 || !result.stdoutBytes) {
      return null
    }
    const output = result.stdoutBytes
    const sources = []
    let offset = 0
    for (const file of files) {
      const end = output.indexOf(10, offset)
      if (end === -1) {
        return null
      }
      const header = output.subarray(offset, end).toString('utf8')
      offset = end + 1
      if (header === `${comparisonBase}:${file} missing`) {
        continue
      }
      const match = /^[0-9a-f]{40}(?:[0-9a-f]{24})? blob (\d+)$/.exec(header)
      if (!match) {
        return null
      }
      const size = Number(match[1])
      if (!Number.isSafeInteger(size) || output[offset + size] !== 10) {
        return null
      }
      sources.push(output.subarray(offset, offset + size).toString('utf8'))
      offset += size + 1
    }
    return offset === output.length ? sources : null
  } catch {
    // Preserve per-file reads when a batch exceeds the output limit or cannot run.
    return null
  }
}

export function collectBaseLineBlocks(root, comparisonBase, files = null) {
  // Read all touched base paths including deletions/rename sources; split code may no longer exist under current paths.
  const paths =
    files ??
    splitNullDelimited(
      runGit(root, ['diff', '--name-only', '--no-renames', '-z', comparisonBase, '--'])
    ).filter((file) => SOURCE_FILE_PATTERN.test(file))
  const blocks = []
  for (let start = 0; start < paths.length; start += 32) {
    const batch = paths.slice(start, start + 32)
    let sources = readBaseSourceBatch(root, comparisonBase, batch)
    if (sources === null) {
      sources = []
      for (const file of batch) {
        try {
          const result = runProcessSync({
            program: 'git',
            args: ['show', `${comparisonBase}:${file}`],
            cwd: root,
            maxOutputBytes: 64 * 1024 * 1024,
            timeoutMs: null
          })
          if (result.code === 0) {
            sources.push(result.stdout)
          }
        } catch {
          // Failed source reads were already skipped by the per-file implementation.
          continue
        }
      }
    }
    for (const source of sources) {
      blocks.push(source.split(/\r?\n/).map(normalizeSourceLine).filter(Boolean))
    }
  }
  return blocks
}

export function isMovedCode(highlightedLines, baseBlocks) {
  return createMovedCodeMatcher(baseBlocks)(highlightedLines)
}

export function createMovedCodeMatcher(baseBlocks) {
  // Base-revision blocks stay fixed for the gate run; normalize each visited block once.
  const normalizedBlocks = new Map()
  return (highlightedLines) => matchMovedCode(highlightedLines, baseBlocks, normalizedBlocks)
}

function matchMovedCode(highlightedLines, baseBlocks, normalizedBlocks) {
  const needle = highlightedLines.map(normalizeSourceLine).filter((line) => line !== '')
  if (needle.length === 0) {
    return false
  }
  // Moved diagnostics can extend into changed dependency arrays; require same base anchor, preserved order and near-complete span rather than exact whole-block equality.
  const MIN_COVERAGE = 0.9
  return baseBlocks.some((block) => {
    let haystack = normalizedBlocks.get(block)
    if (!haystack) {
      haystack = block.map(normalizeSourceLine).filter((line) => line !== '')
      normalizedBlocks.set(block, haystack)
    }
    for (let start = 0; start < haystack.length; start += 1) {
      if (haystack[start] !== needle[0]) {
        continue
      }
      let matched = 1
      let cursor = start + 1
      for (let index = 1; index < needle.length && cursor < haystack.length; index += 1) {
        while (cursor < haystack.length && haystack[cursor] !== needle[index]) {
          cursor += 1
        }
        if (cursor < haystack.length) {
          matched += 1
          cursor += 1
        }
      }
      if (matched / needle.length >= MIN_COVERAGE) {
        return true
      }
    }
    return false
  })
}

function diagnosticHighlightedLines(root, filename, span) {
  const absolutePath = path.isAbsolute(filename) ? filename : path.join(root, filename)
  const source = readFileSync(absolutePath, 'utf8').split(/\r?\n/)
  const range = diagnosticLineRange(root, filename, span)
  if (range === null) {
    return []
  }
  return source.slice(range.start - 1, range.end)
}

export function diagnosticTouchesAddedLines(
  diagnostic,
  rangesByFile,
  root = process.cwd(),
  baseBlocks = [],
  movedCodeMatcher = isMovedCode
) {
  const file = normalizedDiagnosticPath(root, diagnostic.filename)
  const ranges = rangesByFile.get(file)
  if (!ranges) {
    return false
  }
  return (diagnostic.labels ?? []).some((label) => {
    const lineRange = diagnosticLineRange(root, diagnostic.filename, label.span)
    if (lineRange === null || !overlapsAddedLines(lineRange.start, lineRange.end, ranges)) {
      return false
    }
    return !movedCodeMatcher(
      diagnosticHighlightedLines(root, diagnostic.filename, label.span),
      baseBlocks
    )
  })
}

function annotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function printDiagnostic(diagnostic, root) {
  const file = normalizedDiagnosticPath(root, diagnostic.filename)
  const line = diagnostic.labels?.[0]?.span?.line ?? 1
  const code = diagnostic.code ?? 'oxlint'
  console.error(
    `::error file=${annotationValue(file)},line=${line},title=${annotationValue(code)}::${annotationValue(diagnostic.message)}`
  )
  console.error(`${file}:${line} ${code}: ${diagnostic.message}`)
}

// Why: only the casting scan enforces `assertionStyle: never`, so under the root config an
// `as` cast is legal and the SAFETY: directive AGENTS.md mandates reads as unused. The untyped
// scan reports that as a warning, which the gate counts, so exempt exactly those directives.
export function isCastingDirectiveUnusedWarning(diagnostic, root) {
  if (!/^Unused (?:oxlint|eslint)-disable/.test(diagnostic.message ?? '')) {
    return false
  }
  return (diagnostic.labels ?? []).some((label) =>
    diagnosticHighlightedLines(root, diagnostic.filename, label.span).some((line) =>
      CASTING_DISABLE_PATTERN.test(line)
    )
  )
}

// Unloaded plugin directives are checked by their owning scan.
export function isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, scanLabel) {
  if (!/^Unused (?:oxlint|eslint)-disable/.test(diagnostic.message ?? '')) {
    return false
  }
  if (scanLabel === 'React Doctor') {
    const labels = diagnostic.labels ?? []
    return (
      labels.length > 0 &&
      labels.every(({ span }) => {
        if (span.offset === undefined || span.length === undefined) {
          return false
        }
        const file = path.isAbsolute(diagnostic.filename)
          ? diagnostic.filename
          : path.join(root, diagnostic.filename)
        // Oxlint spans use UTF-8 byte offsets, including before non-ASCII comments.
        const directive = readFileSync(file)
          .subarray(span.offset, span.offset + span.length)
          .toString('utf8')
        const rules = directive.split('--')[0]
        return EXPLICIT_DISABLE_RULE_PATTERN.test(rules) && !/\breact-doctor\//.test(rules)
      })
    )
  }
  return (diagnostic.labels ?? []).some((label) =>
    diagnosticHighlightedLines(root, diagnostic.filename, label.span).some(
      (line) =>
        ANTI_SLOP_DISABLE_PATTERN.test(line) ||
        REACT_DOCTOR_DISABLE_PATTERN.test(line) ||
        JS_PLUGIN_DISABLE_PATTERN.test(line)
    )
  )
}

// Why: oxlint cannot see the AGENTS.md requirement that every casting suppression carry a
// line-specific SAFETY: rationale, so the directive text itself is checked over added lines.
export function findCastingDirectivesMissingSafety(root, rangesByFile) {
  const findings = []
  for (const [file, ranges] of rangesByFile) {
    const absolutePath = path.join(root, file)
    if (!existsSync(absolutePath)) {
      continue
    }
    readFileSync(absolutePath, 'utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        const line = index + 1
        if (
          CASTING_DISABLE_PATTERN.test(text) &&
          !text.includes('SAFETY:') &&
          overlapsAddedLines(line, line, ranges)
        ) {
          findings.push({
            filename: file,
            code: `${CASTING_RULE} (missing SAFETY:)`,
            message: `Suppressing ${CASTING_RULE} requires a line-specific "SAFETY:" explanation.`,
            labels: [{ span: { line } }]
          })
        }
      })
  }
  return findings
}

function isSuppressedDiagnostic(diagnostic, root) {
  const files = SUPPRESSED_REACT_DOCTOR_DIAGNOSTICS.get(diagnostic.code)
  return files?.has(normalizedDiagnosticPath(root, diagnostic.filename)) ?? false
}

function runOxlintScan(root, scan, files) {
  const { command, prefixArgs } = resolveOxlintInvocation(root)
  const result = spawnSync(command, [...prefixArgs, ...scan.args, '--format', 'json', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  })
  if (result.error) {
    throw result.error
  }
  if (!result.stdout.trim()) {
    process.stderr.write(result.stderr)
    throw new Error(`${scan.label} failed before producing diagnostics.`)
  }
  return parseOxlintOutput(result.stdout, scan.label).diagnostics ?? []
}

/** ast-grep matches as Oxlint-shaped diagnostics; `info` flaky-test rules are owned by their ratchet. */
export function runAstGrepScan(root, files) {
  return scanAstGrep(root, { minSeverity: 'warning', paths: files }).map((match) => ({
    filename: match.file,
    code: `ast-grep(${match.ruleId})`,
    message: match.message,
    labels: [
      {
        span: {
          line: match.range.start.line + 1,
          offset: match.range.byteOffset.start,
          length: match.range.byteOffset.end - match.range.byteOffset.start
        }
      }
    ]
  }))
}

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--')
) {
  const { comparisonBase, rangesByFile } = collectAddedLineRanges(root, requestedBase)
  const files = [...rangesByFile.keys()]
  if (files.length === 0) {
    console.log(
      `Changed-code quality gate: no changed JavaScript or TypeScript since ${comparisonBase.slice(0, 12)}.`
    )
    return 0
  }

  const baseBlocks = collectBaseLineBlocks(root, comparisonBase)
  const movedCodeMatcher = createMovedCodeMatcher(baseBlocks)

  let failures = 0
  for (const scan of OXLINT_SCANS) {
    const diagnostics = runOxlintScan(root, scan, files).filter(
      (diagnostic) =>
        !isSuppressedDiagnostic(diagnostic, root) &&
        !isCastingDirectiveUnusedWarning(diagnostic, root) &&
        !isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, scan.label) &&
        diagnosticTouchesAddedLines(diagnostic, rangesByFile, root, baseBlocks, movedCodeMatcher)
    )
    for (const diagnostic of diagnostics) {
      printDiagnostic(diagnostic, root)
    }
    failures += diagnostics.length
    console.log(
      `${scan.label}: ${diagnostics.length} new finding(s) across ${files.length} changed file(s).`
    )
  }

  const astGrepFindings = runAstGrepScan(root, files).filter((diagnostic) =>
    diagnosticTouchesAddedLines(diagnostic, rangesByFile, root, baseBlocks, movedCodeMatcher)
  )
  for (const diagnostic of astGrepFindings) {
    printDiagnostic(diagnostic, root)
  }
  failures += astGrepFindings.length
  console.log(
    `ast-grep: ${astGrepFindings.length} new finding(s) across ${files.length} changed file(s).`
  )

  const missingSafety = findCastingDirectivesMissingSafety(root, rangesByFile)
  for (const diagnostic of missingSafety) {
    printDiagnostic(diagnostic, root)
  }
  failures += missingSafety.length
  console.log(
    `casting SAFETY: rationale: ${missingSafety.length} new finding(s) across ${files.length} changed file(s).`
  )

  if (failures > 0) {
    console.error(
      `Changed-code quality gate failed with ${failures} finding(s) since ${comparisonBase.slice(0, 12)}.`
    )
    return 1
  }
  console.log(`Changed-code quality gate passed since ${comparisonBase.slice(0, 12)}.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
