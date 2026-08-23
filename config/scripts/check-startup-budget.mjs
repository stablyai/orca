import {
  collectBudgetViolations,
  parseBudgetArgs,
  readBudgetReport,
  reportBudgetOutcome
} from './perf-budget-gate.mjs'

// Gate for tests/tools/benchmarks/startup-time-bench.mjs reports.
//
// Cold start is the first thing a user feels and nothing guarded it before this.
// Budgets are step-change ceilings sized for a shared CI runner — see the note in
// perf-budget-gate.mjs. Recalibrate with `--print-only` after a runner change.
const BUDGETS = {
  // Spawn to the window finishing its first load.
  totalToDidFinishLoad: { max: 20_000, unit: 'ms', required: true },
  // Spawn to the renderer reporting hydration done. Only present when the bench
  // ran with --wait-for-event renderer-startup-hydration-done.
  totalToWorkspaceReady: { max: 30_000, unit: 'ms', required: false },
  // The issue-#7225 metric: the worst single main-thread stall. A blocking sync
  // call in boot shows up here regardless of how fast the runner is, which makes
  // this the least noise-prone signal in the report.
  maxEventLoopStallMs: { max: 3_000, unit: 'ms', required: false },
  startupStoreLoadMs: { max: 8_000, unit: 'ms', required: false },
  daemonInitMs: { max: 15_000, unit: 'ms', required: false }
}

const { reportPath, printOnly } = parseBudgetArgs(
  process.argv,
  'Usage: node config/scripts/check-startup-budget.mjs <startup-report.json> [--print-only]'
)

const report = readBudgetReport(reportPath)
const metrics = report.summaryMedianMs
if (!metrics || typeof metrics !== 'object') {
  console.error(`::error::${reportPath} has no summaryMedianMs block — is this a startup report?`)
  process.exit(1)
}

process.exit(
  reportBudgetOutcome('startup', collectBudgetViolations(metrics, BUDGETS), printOnly)
)
