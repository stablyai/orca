import {
  collectBudgetViolations,
  parseBudgetArgs,
  readBudgetReport,
  reportBudgetOutcome
} from './perf-budget-gate.mjs'

// Gate for tests/tools/benchmarks/daemon-coldstart-bench.mjs reports.
//
// The daemon boots on the path to a usable terminal, so its cold start lands in
// the same wall-clock a user waits through. legacyPidFilesAfter is the structural
// one: it counts leftover pid files, so it is a hard 0 rather than a timing
// ceiling and cannot flake on a slow runner.
const BUDGETS = {
  daemonInitTotal: { max: 15_000, unit: 'ms', required: true },
  daemonInitToCurrentReady: { max: 10_000, unit: 'ms', required: false },
  pidCheckMaxMs: { max: 5_000, unit: 'ms', required: false },
  maxEventLoopStallMs: { max: 3_000, unit: 'ms', required: false },
  legacyPidFilesAfter: { max: 0, unit: 'count', required: false }
}

const { reportPath, printOnly } = parseBudgetArgs(
  process.argv,
  'Usage: node config/scripts/check-daemon-coldstart-budget.mjs <report.json> [--print-only]'
)

const report = readBudgetReport(reportPath)
const metrics = report.summaryMedian
if (!metrics || typeof metrics !== 'object') {
  console.error(`::error::${reportPath} has no summaryMedian block — is this a coldstart report?`)
  process.exit(1)
}

process.exit(
  reportBudgetOutcome('daemon-coldstart', collectBudgetViolations(metrics, BUDGETS), printOnly)
)
