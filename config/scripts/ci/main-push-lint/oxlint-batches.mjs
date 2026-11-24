// Run oxlint over explicit paths in bounded batches and tell lint errors apart from runs that did not finish.
import { execFile } from 'node:child_process'

const MAX_BUFFER_BYTES = 64 * 1024 * 1024
// Windows caps a whole command line at 32,767 characters; leave room for node, the bin path and options.
const MAX_PATH_CHARS_PER_RUN = 24_000
// The step times out at 5 minutes; stop linting well before, so finished batches and PR lookups still report.
export const LINT_BUDGET_MS = 180_000
// oxlint exits 1 when it reports lint errors; any other exit, a signal or a spawn error is operational.
const LINT_ERROR_EXIT = 1
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

function runOnce(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ error, output: `${String(stdout ?? '')}${String(stderr ?? '')}` })
    })
  })
}

// What stopped a child, if anything other than a clean exit: exit code, signal, timeout or spawn error.
function describeFailure(error, timedOut, maxBuffer) {
  if (!error) {
    return { failed: false }
  }
  if (timedOut) {
    return { failed: true, reason: 'stopped when the lint time budget ran out' }
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { failed: true, reason: `its output exceeded ${maxBuffer} bytes` }
  }
  if (error.signal) {
    return { failed: true, reason: `killed by ${error.signal}` }
  }
  if (typeof error.code === 'number') {
    return { failed: true, exitCode: error.code, reason: `exit code ${error.code}` }
  }
  return { failed: true, reason: `could not run oxlint (${error.code ?? error.message})` }
}

// Each batch keeps its own output and outcome, so one batch's lint errors never hide another batch's failure.
// One deadline covers every batch: a stalled run is stopped, and later batches are reported as not run.
// With `onResult`, each result is handed over as its child ends and nothing is kept here, so one child's output
// is the most held at once.
export async function runOxlint(
  paths,
  {
    cwd,
    invocation,
    budgetMs = LINT_BUDGET_MS,
    maxChars = MAX_PATH_CHARS_PER_RUN,
    maxBuffer = MAX_BUFFER_BYTES,
    onResult
  }
) {
  const deadline = Date.now() + budgetMs
  const results = []
  const report = onResult ?? ((result) => results.push(result))
  for (const batch of batchPaths(paths, maxChars)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      report({
        files: batch,
        failed: true,
        reason: 'not run: the lint time budget ran out',
        notRun: true,
        output: ''
      })
      continue
    }
    // `--` keeps a path such as `--format=x.ts` from being read as an option.
    const args = [
      ...invocation.prefixArgs,
      '--format',
      'github',
      '--quiet',
      '--no-error-on-unmatched-pattern',
      '--',
      ...batch
    ]
    const { error, output } = await runOnce(invocation.command, args, {
      cwd,
      maxBuffer,
      timeout: remaining,
      killSignal: 'SIGKILL'
    })
    // Only the timeout kills a child here.
    report({ files: batch, output, ...describeFailure(error, Boolean(error?.killed), maxBuffer) })
  }
  return results
}

function decodeAnnotation(value) {
  const codes = { '%25': '%', '%0D': '\r', '%0A': '\n', '%3A': ':', '%2C': ',' }
  return value.replace(/%(?:25|0D|0A|3A|2C)/g, (code) => codes[code])
}

// Parses `oxlint --format github` lines: `::error file=<path>,line=<n>,...,title=<rule>::<path>:<line>:<col>: <message>`.
// The format escapes only CR, LF and %, so a line can hold U+2028/U+2029; split on LF and let `.` match them.
export function parseGithubDiagnostics(output) {
  const diagnostics = []
  for (const rawLine of output.split('\n')) {
    const match = /^::(error|warning) (.*?)::(.*)$/s.exec(rawLine.replace(/\r$/, ''))
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

// What the run keeps: each child's raw output is digested as it ends, then only an excerpt of an unfinished run,
// and at most `maxDiagnostics` errors (counting the rest), each message cut to `maxMessageChars`.
export const RETAIN_LIMITS = {
  maxDiagnostics: 5_000,
  maxMessageChars: 2_000,
  maxExcerptChars: 4_000
}

function cut(text, maxChars) {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… (${text.length - maxChars} more characters)`
    : text
}

// A batch counts only if oxlint finished it and exited cleanly, or exited 1 with a parsed lint error.
// Errors parsed from an unfinished batch are still reported, next to why it did not finish. An error reported
// twice (a Git-ignored file named next to the directory that holds it) is kept once.
export function createBatchCollector(limits = RETAIN_LIMITS) {
  const diagnostics = []
  const seen = new Set()
  const incomplete = []
  let errorCount = 0
  let linted = 0
  return {
    add(batch) {
      const errors = parseGithubDiagnostics(batch.output).filter(
        (diagnostic) => diagnostic.severity === 'error'
      )
      for (const error of errors) {
        const key = JSON.stringify([error.file, error.line, error.col, error.rule, error.message])
        if (seen.has(key)) {
          continue
        }
        errorCount += 1
        if (diagnostics.length < limits.maxDiagnostics) {
          seen.add(key)
          diagnostics.push({ ...error, message: cut(error.message, limits.maxMessageChars) })
        }
      }
      const finished = FINISHED_LINE.exec(batch.output)
      const explained = !batch.failed || (batch.exitCode === LINT_ERROR_EXIT && errors.length > 0)
      if (finished && explained) {
        linted += Number(finished[1])
        return
      }
      const reasons = []
      if (batch.failed) {
        reasons.push(
          batch.exitCode === LINT_ERROR_EXIT && errors.length === 0
            ? 'exit code 1 without a parsed lint error'
            : batch.reason
        )
      }
      if (!finished && !batch.failed) {
        reasons.push('no Finished line')
      }
      incomplete.push({
        files: batch.files,
        // A batch the deadline kept from starting never reached oxlint.
        ran: !batch.notRun,
        reason: reasons.join('; '),
        output: cut(batch.output, limits.maxExcerptChars)
      })
    },
    result() {
      return { diagnostics, errorCount, incomplete, linted }
    }
  }
}

export function collectBatchResults(batches, limits) {
  const collector = createBatchCollector(limits)
  for (const batch of batches) {
    collector.add(batch)
  }
  return collector.result()
}
