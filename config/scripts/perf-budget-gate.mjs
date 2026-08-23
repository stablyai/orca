import { readFileSync } from 'node:fs'

// Shared budget gate for the startup / idle-CPU / daemon-coldstart benchmarks.
//
// Each bench already writes a JSON report with a median summary; this turns that
// report into a pass/fail without rerunning Electron, the same way
// check-terminal-perf-report-budgets.mjs gates the terminal perf report.
//
// These are STEP-CHANGE ceilings, not drift detectors. A shared GitHub runner
// varies enough between runs that a 10% budget would flap, so budgets are set
// well above observed values and are meant to catch the class of regression that
// changes the shape of startup — a new blocking sync call, an eager require, a
// spinning timer, a leaked process. Tightening them needs a dedicated runner.

// Exits rather than throwing: a missing or truncated report means the bench died,
// and a raw stack trace buries that under noise in the CI log.
export function readBudgetReport(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`::error::Cannot read perf report ${path}: ${error.message}`)
    console.error('  The benchmark likely failed before writing its report — check the step above.')
    process.exit(1)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    console.error(`::error::Perf report ${path} is not valid JSON: ${error.message}`)
    process.exit(1)
  }
}

function formatValue(value, unit) {
  if (unit === 'bytes') {
    return `${(value / 1_000_000).toFixed(0)}MB`
  }
  if (unit === '%') {
    return `${value.toFixed(1)}%`
  }
  if (unit === 'ms') {
    return `${Math.round(value)}ms`
  }
  return String(value)
}

/**
 * budgets: { <metric>: { max, unit, required } }
 * metrics: flat object of measured values (null/undefined = not observed)
 *
 * A `required` metric that is absent is a FAILURE, not a skip — otherwise
 * renaming a phase in the bench would silently switch the gate off.
 */
export function collectBudgetViolations(metrics, budgets) {
  const violations = []
  const rows = []
  for (const [metric, spec] of Object.entries(budgets)) {
    const value = metrics?.[metric]
    if (value === null || value === undefined) {
      if (spec.required) {
        violations.push(`${metric}: required metric missing from report`)
      }
      rows.push({ metric, value: null, spec })
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      violations.push(`${metric}: value ${JSON.stringify(value)} is not a finite number`)
      rows.push({ metric, value: null, spec })
      continue
    }
    rows.push({ metric, value, spec })
    if (value > spec.max) {
      violations.push(
        `${metric}: ${formatValue(value, spec.unit)} exceeded budget ${formatValue(spec.max, spec.unit)}`
      )
    }
  }
  return { violations, rows }
}

export function printBudgetTable(name, rows) {
  console.log(`\n${name} — measured vs budget`)
  console.log('| metric | measured | budget | headroom |')
  console.log('|---|---|---|---|')
  for (const { metric, value, spec } of rows) {
    if (value === null) {
      console.log(`| ${metric} | not observed | ${formatValue(spec.max, spec.unit)} | — |`)
      continue
    }
    const pct = spec.max === 0 ? '—' : `${Math.round((1 - value / spec.max) * 100)}%`
    console.log(
      `| ${metric} | ${formatValue(value, spec.unit)} | ${formatValue(spec.max, spec.unit)} | ${pct} |`
    )
  }
}

/**
 * Prints the table, then the violations. Returns the process exit code.
 * `printOnly` reports measurements without failing — used to calibrate budgets
 * on a new runner before turning the gate on.
 */
export function reportBudgetOutcome(name, { violations, rows }, printOnly = false) {
  printBudgetTable(name, rows)
  if (violations.length === 0) {
    console.log(`\n${name} budget check passed (${rows.length} metric(s)).`)
    return 0
  }
  for (const violation of violations) {
    console.error(`::error::${name}: ${violation}`)
  }
  console.error(`\n${name} budget check failed with ${violations.length} violation(s):`)
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  if (printOnly) {
    console.error('\n(--print-only: reporting without failing.)')
    return 0
  }
  return 1
}

// Shared CLI shape: `<script> <report.json> [--print-only]`.
export function parseBudgetArgs(argv, usage) {
  const args = argv.slice(2).filter((a) => a !== '--')
  const printOnly = args.includes('--print-only')
  const reportPath = args.find((a) => !a.startsWith('--'))
  if (!reportPath) {
    console.error(usage)
    process.exit(1)
  }
  return { reportPath, printOnly }
}
