// Run oxlint over explicit paths in bounded batches and tell lint errors apart from runs that did not finish.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
// Windows caps a whole command line at 32,767 characters; leave room for node, the bin path and options.
const MAX_PATH_CHARS_PER_RUN = 24_000
// oxlint prints this only after it has linted every path it accepted. With nested configs it omits
// "with N rules": `Finished in 32ms on 1 file using 18 threads.`
const FINISHED_LINE = /^Finished in .* on (\d+) files? (?:with \d+ rules? )?using /m

export function batchPaths(files, maxChars = MAX_PATH_CHARS_PER_RUN) {
  const batches = []
  let current = []
  let chars = 0
  for (const file of files) {
    if (current.length > 0 && chars + file.length + 1 > maxChars) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(file)
    chars += file.length + 1
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

// Each batch keeps its own output, so one batch's lint errors never hide another batch's failure.
export async function runOxlint(files, { cwd, invocation }) {
  const results = []
  for (const paths of batchPaths(files)) {
    // `--` keeps a path such as `--format=x.ts` from being read as an option.
    const args = [
      ...invocation.prefixArgs,
      '--format',
      'github',
      '--quiet',
      '--no-error-on-unmatched-pattern',
      '--',
      ...paths
    ]
    try {
      const { stdout, stderr } = await execFileAsync(invocation.command, args, {
        cwd,
        maxBuffer: MAX_BUFFER_BYTES
      })
      results.push({ files: paths, failed: false, output: `${stdout}${stderr}` })
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      results.push({ files: paths, failed: true, output: output || `${error.message}\n` })
    }
  }
  return results
}

function decodeAnnotation(value) {
  const codes = { '%25': '%', '%0D': '\r', '%0A': '\n', '%3A': ':', '%2C': ',' }
  return value.replace(/%(?:25|0D|0A|3A|2C)/g, (code) => codes[code])
}

// Parses `oxlint --format github` lines: `::error file=<path>,line=<n>,...,title=<rule>::<path>:<line>:<col>: <message>`.
export function parseGithubDiagnostics(output) {
  const diagnostics = []
  for (const line of output.split('\n')) {
    const match = /^::(error|warning) (.*?)::(.*)$/.exec(line.trim())
    if (!match) {
      continue
    }
    const properties = Object.fromEntries(
      match[2].split(',').map((pair) => {
        const separator = pair.indexOf('=')
        return [pair.slice(0, separator), decodeAnnotation(pair.slice(separator + 1))]
      })
    )
    const text = decodeAnnotation(match[3])
    // Fileless errors, such as a config problem, carry no file, line or col.
    const file = properties.file ?? null
    const prefix = file ? `${file}:${properties.line}:${properties.col}: ` : null
    diagnostics.push({
      severity: match[1],
      file,
      line: file ? Number(properties.line) : null,
      col: file ? Number(properties.col) : null,
      rule: properties.title ?? 'oxlint',
      message: prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text
    })
  }
  return diagnostics
}

// A batch counts only if oxlint finished it and any nonzero exit is explained by a parsed error.
export function collectBatchResults(batches) {
  const diagnostics = []
  const incomplete = []
  let linted = 0
  for (const batch of batches) {
    const errors = parseGithubDiagnostics(batch.output).filter(
      (diagnostic) => diagnostic.severity === 'error'
    )
    diagnostics.push(...errors)
    const finished = FINISHED_LINE.exec(batch.output)
    if (finished && (!batch.failed || errors.length > 0)) {
      linted += Number(finished[1])
    } else {
      incomplete.push({ files: batch.files, output: batch.output })
    }
  }
  return { diagnostics, incomplete, linted }
}
