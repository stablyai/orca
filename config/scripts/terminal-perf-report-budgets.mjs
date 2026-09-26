// Historical measurements and rationale: docs/reference/terminal-perf-report-budgets.md.
const MIB = 1024 * 1024

const DEFAULT_BUDGETS = {
  median: 25,
  worst: 300,
  revisit: 300,
  maxTimerDrift: 150,
  scroll: 150,
  restore: 1_000,
  rendererQueuedChars: 2 * MIB,
  rendererPeakQueuedChars: 2 * MIB,
  rendererDroppedBacklogs: 0
}

export function reportBudgetsForScenario(scenario) {
  const budgets = { ...DEFAULT_BUDGETS }
  // Preserve the existing report gate's injected-redraw drift allowance.
  if (
    scenario === 'opencode-same-workspace-typing' ||
    scenario === 'opencode-cross-workspace-typing' ||
    scenario.startsWith('opencode-scale-same-workspace-') ||
    scenario.startsWith('opencode-scale-cross-workspace-')
  ) {
    budgets.maxTimerDrift = 3_500
  }
  if (
    scenario === 'opencode-main-pressure-active-typing' ||
    scenario.startsWith('opencode-main-pressure-active-typing-') ||
    scenario === 'opencode-main-pressure-worktree-revisit-typing' ||
    scenario === 'opencode-main-pressure-worktree-revisit-drain'
  ) {
    // Only the transient peak gets headroom; current backlog must still drain below 2 MiB.
    budgets.rendererPeakQueuedChars = 3.5 * MIB
  }
  return budgets
}
