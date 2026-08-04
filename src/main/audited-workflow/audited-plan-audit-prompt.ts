// Builds the Codex plan-audit prompt (Phase 5). PURE — assembled entirely in
// main from durable state. The renderer supplies nothing: not the prompt, the
// model, the cwd, the argv, the output path, or any config.
//
// The plan text inlined here is the ALREADY-SANITIZED artifact body, so the
// prompt cannot reintroduce a path or secret that redaction removed.
//
// The review instructions are NOT a security boundary — a model may ignore any
// of them. Read-only enforcement is `--sandbox read-only` plus
// `-c approval_policy="never"` (see audited-codex-launch-plan.ts), and the
// authoritative Git boundary is post-run drift detection.
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'

export type PlanAuditPromptArgs = {
  title: string
  description: string
  acceptanceCriteria: readonly AuditedAcceptanceCriterion[]
  planText: string
}

export function buildPlanAuditPrompt(args: PlanAuditPromptArgs): string {
  const criteria = args.acceptanceCriteria.length
    ? args.acceptanceCriteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
    : '(none recorded)'

  return [
    'You are auditing an implementation PLAN before any code is written.',
    'Review only. Do not edit files, run mutating commands, or use Git in any way.',
    '',
    '## Task',
    args.title,
    '',
    '## Description',
    args.description.trim().length > 0 ? args.description : '(none provided)',
    '',
    '## Acceptance criteria',
    criteria,
    '',
    '## Proposed plan',
    args.planText,
    '',
    '## What to judge',
    '- Does the plan actually satisfy every acceptance criterion?',
    '- Are there correctness, safety, or data-loss risks in the approach?',
    '- Does it contradict the existing code it claims to change?',
    '- Are there missing steps that would leave the task half-done?',
    '',
    '## Required output',
    'Your FINAL message must be exactly one JSON object and nothing else:',
    '{"verdict":"approved|fixes_requested|blocked","summary":"<one paragraph>","findings":[{"severity":"low|medium|high","text":"<finding>"}]}',
    '',
    'Use "approved" only if the plan is safe to implement as written.',
    'Use "fixes_requested" if it needs changes you can describe.',
    'Use "blocked" if the plan cannot proceed at all.',
    'Do not use any other verdict value.'
  ].join('\n')
}
