import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/
export const OXLINT_SCANS = [
  {
    // Why: no --config, so Oxlint keeps discovering nested configs. Pinning the root
    // config would apply root rules to mobile/, whose .oxlintrc.json turns them off.
    label: 'code quality',
    args: ['--report-unused-disable-directives-severity', 'warn']
  },
  {
    label: 'type-aware code quality',
    args: ['--type-aware', '--config', 'config/oxlint-code-quality-type-aware.json']
  },
  {
    label: 'React Doctor',
    args: ['--config', 'config/oxlint-react-doctor.json']
  }
]

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

export function collectAddedLineRanges(root, requestedBase) {
  const base = resolveBase(root, requestedBase)
  const mergeBase = runGit(root, ['merge-base', base, 'HEAD']).trim()
  const comparisonBase = resolvePullRequestDiffBase(root, mergeBase)
  const changedFiles = splitNullDelimited(
    runGit(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUB', comparisonBase, '--'])
  )
  const untrackedFiles = splitNullDelimited(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  const rangesByFile = new Map()

  for (const file of changedFiles) {
    if (!SOURCE_FILE_PATTERN.test(file) || !existsSync(path.join(root, file))) {
      continue
    }
    const diff = runGit(root, ['diff', '--unified=0', '--no-color', comparisonBase, '--', file])
    const ranges = parseAddedLineRanges(diff)
    if (ranges.length > 0) {
      rangesByFile.set(file, ranges)
    }
  }

  for (const file of untrackedFiles) {
    const absolutePath = path.join(root, file)
    if (!SOURCE_FILE_PATTERN.test(file) || !existsSync(absolutePath)) {
      continue
    }
    const lineCount = readFileSync(absolutePath, 'utf8').split(/\r?\n/).length
    rangesByFile.set(file, [{ start: 1, end: lineCount }])
  }
  return { base, comparisonBase, rangesByFile }
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

// Why: a file-splitting refactor makes every line of the new module an "added"
// line, so pre-existing lint debt in code that merely MOVED starts failing the
// changed-lines gate. The only way to satisfy it is to edit the moved code,
// which is exactly what a behavior-preserving refactor must not do. So a
// diagnostic is exempt when its highlighted lines already existed, verbatim and
// contiguous, somewhere in the base revision of the files this change touches.
function normalizeSourceLine(line) {
  return line.replace(/\s+/g, ' ').trim()
}

export function collectBaseLineBlocks(root, comparisonBase, files = null) {
  // Why: in a split, the moved code's base text lives in the ORIGINAL file, which is
  // often deleted or renamed away. Deleted paths never reach the changed-file list
  // (it filters to ACMRTUB), so read every path the diff touches, deletions included.
  const paths =
    files ??
    splitNullDelimited(runGit(root, ['diff', '--name-only', '-z', comparisonBase, '--'])).filter(
      (file) => SOURCE_FILE_PATTERN.test(file)
    )
  const blocks = []
  for (const file of paths) {
    const result = spawnSync('git', ['show', `${comparisonBase}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      continue
    }
    blocks.push(
      result.stdout
        .split(/\r?\n/)
        .map(normalizeSourceLine)
        .filter((line) => line !== '')
    )
  }
  return blocks
}

export function isMovedCode(highlightedLines, baseBlocks) {
  const needle = highlightedLines.map(normalizeSourceLine).filter((line) => line !== '')
  if (needle.length === 0) {
    return false
  }
  // Why a near-match rather than an exact contiguous one: a split moves a block
  // verbatim but a diagnostic's span often reaches past it — most commonly to a
  // hook dependency array, which legitimately grows when closure variables become
  // props. Requiring every line to match would report the moved body as new. So:
  // the block must still start at the same line in the base and appear IN ORDER,
  // and nearly all of it must be present. Genuinely new code shares neither the
  // anchor nor the ordering, so it stays reported.
  const MIN_COVERAGE = 0.9
  return baseBlocks.some((rawHaystack) => {
    const haystack = rawHaystack.map(normalizeSourceLine).filter((line) => line !== '')
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
  baseBlocks = []
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
    return !isMovedCode(
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

function runOxlintScan(root, scan, files) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, ['exec', 'oxlint', ...scan.args, '--format', 'json', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
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

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--')
) {
  const { base, comparisonBase, rangesByFile } = collectAddedLineRanges(root, requestedBase)
  const files = [...rangesByFile.keys()]
  if (files.length === 0) {
    console.log(`Changed-code quality gate: no changed JavaScript or TypeScript since ${base}.`)
    return 0
  }

  const baseBlocks = collectBaseLineBlocks(root, comparisonBase)

  let failures = 0
  for (const scan of OXLINT_SCANS) {
    const diagnostics = runOxlintScan(root, scan, files).filter((diagnostic) =>
      diagnosticTouchesAddedLines(diagnostic, rangesByFile, root, baseBlocks)
    )
    for (const diagnostic of diagnostics) {
      printDiagnostic(diagnostic, root)
    }
    failures += diagnostics.length
    console.log(
      `${scan.label}: ${diagnostics.length} new finding(s) across ${files.length} changed file(s).`
    )
  }

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
