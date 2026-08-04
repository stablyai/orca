// Builds the Codex code-audit prompt (Phase 7). PURE — assembled entirely in main
// from durable state. The renderer supplies nothing: not the prompt, the model,
// the cwd, the argv, the output path, or any config.
//
// NO DIFF IS INLINED. The plan audit inlines the sanitized plan text because a
// plan is small and its bytes ARE the artifact. A code candidate is the worktree
// itself: Codex runs with `--cd <worktree>` under `--sandbox read-only` and reads
// the files directly, so inlining a diff would duplicate unbounded, unsanitized
// content into the prompt for no gain.
//
// The review instructions are NOT a security boundary — a model may ignore any of
// them. Read-only enforcement is `--sandbox read-only` plus
// `-c approval_policy="never"`, and the authoritative Git boundary is post-run
// drift detection plus the candidate-tree recomputation at finalization.
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'

export type CodeAuditPromptArgs = {
  title: string
  description: string
  acceptanceCriteria: readonly AuditedAcceptanceCriterion[]
  /** The base the work is measured against, so the model can diff it itself. */
  baseCommit: string
  /** Completed fix rounds, so the model knows this is a re-audit. */
  fixRound: number
}

export function buildCodeAuditPrompt(args: CodeAuditPromptArgs): string {
  const criteria = args.acceptanceCriteria.length
    ? args.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`).join('\n')
    : '(none recorded)'

  return [
    'You are auditing an IMPLEMENTATION that has been written but not committed.',
    'Review only. Do not edit files, run mutating commands, or use Git in any way.',
    '',
    'The working tree contains uncommitted changes. To see them, read the files;',
    `they are measured against base commit ${args.baseCommit}.`,
    '',
    '## Task',
    args.title,
    '',
    '## Description',
    args.description.trim().length > 0 ? args.description : '(none provided)',
    '',
    '## Acceptance criteria',
    criteria,
    ...(args.fixRound > 0
      ? ['', `## Note`, `This is a re-audit after ${args.fixRound} fix round(s).`]
      : []),
    '',
    '## What to judge',
    '- Does the implementation actually satisfy every acceptance criterion?',
    '- Are there correctness, safety, or data-loss defects in the code as written?',
    '- Does it break existing behavior it did not intend to change?',
    '- Are there missing pieces that would leave the task half-done?',
    '',
    '## Required output',
    'Your FINAL message must be exactly one JSON object and nothing else:',
    '{"verdict":"approved|fixes_requested|blocked","summary":"<one paragraph>","findings":[{"severity":"low|medium|high","text":"<finding>"}]}',
    '',
    'Use "approved" only if the implementation is correct and safe as written.',
    'Use "fixes_requested" if it needs changes you can describe.',
    'Use "blocked" if the implementation cannot proceed at all.',
    'Do not use any other verdict value.'
  ].join('\n')
}
