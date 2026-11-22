import { defineConfig } from 'vitest/config'

// Real agent CLIs as bots; never part of the unit run. Knobs: ORCA_BOT_EVAL_AGENT (claude|codex),
// ORCA_BOT_EVAL_RUNS, ORCA_BOT_EVAL_CONCURRENCY, ORCA_BOT_EVAL_ONLY (scenario ids),
// ORCA_BOT_EVAL_OUT (report file; transcripts beside it), ORCA_BOT_EVAL_MIN_PASS_RATE,
// ORCA_BOT_EVAL_ORCA_CHECKOUT (required: a clean orca checkout bots may read; edits to it fail the thread),
// ORCA_BOT_EVAL_MODEL (pins the agent's model; the report names it and the CLI version).
// Needs zsh as the login shell, as the automation eval does.
export default defineConfig({
  test: {
    include: ['src/cli/bot-orchestration-eval/*.eval.ts'],
    environment: 'node',
    fileParallelism: false,
    // One zone for the grader, the stand-in and the agents, so schedules read the same everywhere.
    env: { TZ: 'America/New_York' },
    retry: 0
  }
})
