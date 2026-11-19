import { defineConfig } from 'vitest/config'

// Real agent CLIs as bots; never part of the unit run. Knobs: ORCA_BOT_EVAL_AGENT (claude|codex),
// ORCA_BOT_EVAL_RUNS, ORCA_BOT_EVAL_CONCURRENCY, ORCA_BOT_EVAL_ONLY (scenario ids or categories),
// ORCA_BOT_EVAL_OUT (report file), ORCA_BOT_EVAL_MIN_PASS_RATE. Needs zsh as the login shell: the
// tool shims stay first on PATH only through a zsh profile, so it refuses to start otherwise.
export default defineConfig({
  test: {
    include: ['src/cli/bot-automation-eval/*.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    // One zone for the grader, the stand-in and the agents, so schedules read the same everywhere.
    env: { TZ: 'America/New_York' },
    retry: 0
  }
})
