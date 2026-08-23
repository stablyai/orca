import {
  collectBudgetViolations,
  parseBudgetArgs,
  readBudgetReport,
  reportBudgetOutcome
} from './perf-budget-gate.mjs'

// Gate for config/scripts/run-idle-cpu-benchmark.mjs reports.
//
// Idle CPU is the most runner-independent signal Orca measures: a sitting-still
// app should be near zero on any hardware, so a spinning timer or a re-render
// loop reads as 3% -> 40% rather than as runner noise. That makes this the
// budget worth trusting most, and the one most worth keeping tight.
const BUDGETS = {
  meanCpuPercent: { max: 25, unit: '%', required: true },
  p95CpuPercent: { max: 60, unit: '%', required: true },
  // All Orca processes summed. Guards against a leak that only shows at idle.
  meanRssBytes: { max: 2_000_000_000, unit: 'bytes', required: true }
}

const { reportPath, printOnly } = parseBudgetArgs(
  process.argv,
  'Usage: node config/scripts/check-idle-cpu-budget.mjs <idle-cpu-report.json> [--print-only]'
)

const report = readBudgetReport(reportPath)
const metrics = report.summary?.total
if (!metrics || typeof metrics !== 'object') {
  console.error(`::error::${reportPath} has no summary.total block — is this an idle-cpu report?`)
  process.exit(1)
}

process.exit(
  reportBudgetOutcome('idle-cpu', collectBudgetViolations(metrics, BUDGETS), printOnly)
)
