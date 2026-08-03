// Resolves the Claude-ready prompt for a task from its latest SUCCEEDED triage
// run. Phase 2 wrote next_step_prompt and nothing has ever read it; this is its
// first and only consumer.
//
// The prompt is derived in main from durable state — it never crosses IPC in
// either direction, and the renderer cannot supply or override it.
import type Database from '../sqlite/sync-database'

/**
 * Returns the prompt, or null when there is no succeeded run or the stored
 * prompt is absent/blank. Callers refuse with `prompt_unavailable` rather than
 * launching Claude with nothing to do.
 */
export function resolveNextStepPrompt(db: Database.Database, taskId: string): string | null {
  const row = db
    .prepare(
      `SELECT next_step_prompt FROM audited_triage_runs
        WHERE task_id = ? AND status = 'succeeded'
        ORDER BY ended_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { next_step_prompt: string | null } | undefined

  const prompt = row?.next_step_prompt ?? null
  if (prompt === null || !/\S/.test(prompt)) {
    return null
  }
  return prompt
}
