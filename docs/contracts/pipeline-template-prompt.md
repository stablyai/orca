# Pipeline Template / Prompt Contract

## Source

- PRD: `docs/prd/orca-sandcastle-like-pipeline.md`
- Architecture: `docs/architecture/orca-pipeline-architecture.md`
- Sandcastle reference files:
  - `src/templates/parallel-planner-with-review/main.mts`
  - `src/templates/parallel-planner/plan-prompt.md`
  - `src/templates/parallel-planner/implement-prompt.md`
  - `src/templates/parallel-planner-with-review/review-prompt.md`
  - `src/templates/parallel-planner/merge-prompt.md`
  - `src/extractStructuredOutput.ts`
  - `src/PromptArgumentSubstitution.ts`
  - `src/PromptPreprocessor.ts`

## PipelineTemplate

```ts
type PipelineTemplate = {
  id: string
  name: string
  description: string
  version: number
  maxIterationsDefault: number
  maxConcurrentDefault: number
  stages: PipelineStageDefinition[]
  prompts: {
    planner: PipelinePromptDefinition
    implementer: PipelinePromptDefinition
    reviewer?: PipelinePromptDefinition
    merger: PipelinePromptDefinition
    verifier?: PipelinePromptDefinition
  }
  plannerOutput: PipelineStructuredOutputDefinition
  taskSourceKinds: PipelineTaskSourceKind[]
  safety: PipelineTemplateSafetyPolicy
}
```

## Structured Planner Output

v1 planner output uses the last `<plan>...</plan>` block.

```ts
type PipelinePlannerOutputV1 = {
  issues: {
    id: string
    title: string
    branch: string
    blockedBy?: string[]
  }[]
}
```

Extraction rules:

| ID      | Rule                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| C-OUT-1 | Find the last matching `<plan>...</plan>` pair.                                                                |
| C-OUT-2 | Support plain JSON and `json` code fences.                                                                     |
| C-OUT-3 | Fail if tag is missing.                                                                                        |
| C-OUT-4 | Fail if JSON parse fails.                                                                                      |
| C-OUT-5 | Fail if schema validation fails.                                                                               |
| C-OUT-6 | Error payload includes run id, iteration id, stage id, terminal id, tag, failure kind, and raw output summary. |

## Prompt Arguments

Built-in prompt args:

| Key                  | Source                               |
| -------------------- | ------------------------------------ |
| `SOURCE_BRANCH`      | PipelineRunInput                     |
| `TARGET_BRANCH`      | PipelineRunInput                     |
| `TASK_ID`            | PipelineTask source id               |
| `ISSUE_TITLE`        | PipelineTask title                   |
| `BRANCH`             | PipelineTask branch                  |
| `VIEW_TASK_COMMAND`  | TaskSource adapter                   |
| `LIST_TASKS_COMMAND` | TaskSource adapter                   |
| `CLOSE_TASK_COMMAND` | TaskSource adapter, closure stage only |
| `BRANCHES`           | Merge stage branch list              |
| `ISSUES`             | Merge stage issue list               |

Rules:

| ID         | Rule                                                                                                                                                                                                  | Test          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C-PROMPT-1 | Unknown `{{KEY}}` placeholders fail render.                                                                                                                                                           | Unit          |
| C-PROMPT-2 | User args cannot override built-in args.                                                                                                                                                              | Unit          |
| C-PROMPT-3 | Unused args warn but do not fail, except when policy says strict.                                                                                                                                     | Unit          |
| C-PROMPT-4 | Inline prompts do not accept prompt args.                                                                                                                                                             | Unit          |
| C-PROMPT-5 | Prompt args are data only; they cannot create dynamic context commands. User args also cannot fill placeholders inside dynamic context command blocks; only Pipeline-owned built-in args may do that. | Security unit |
| C-PROMPT-6 | `CLOSE_TASK_COMMAND` is exposed only to template stages that are responsible for issue closure, such as the RALPH implement close step or the parallel merger close step.                            | Unit          |
| C-PROMPT-7 | A closure-capable prompt must verify, commit, and only then close its issue. The next task-source snapshot must not treat an issue as complete until it is closed.                                  | Integration   |

## Dynamic Context

Template authors may include dynamic context blocks:

```md
!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`
```

Security rules:

| ID      | Rule                                                                                   | Reason                                                      |
| ------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C-SEC-1 | Only commands present in the raw template before argument substitution are executable. | Prevents issue text or user input from becoming shell code. |
| C-SEC-2 | Strip internal shell-block markers from raw template and arg values before rendering.  | Prevents marker forgery.                                    |
| C-SEC-3 | Dynamic context runs in the stage worktree cwd.                                        | Keeps context tied to the correct branch.                   |
| C-SEC-4 | Command timeout default is 30 seconds unless template policy narrows it.               | Prevents hung prompt expansion.                             |
| C-SEC-5 | Non-zero exit code fails the stage before agent launch.                                | Prevents prompts with missing or partial context.           |
| C-SEC-6 | Stdout/stderr are length-limited and recorded in `pipeline_dynamic_context_results`.   | Keeps logs inspectable and bounded.                         |
| C-SEC-7 | SSH/runtime execution uses the same worktree target as the stage terminal.             | Preserves remote correctness.                               |
| C-SEC-8 | Dynamic context never receives secrets through template args.                          | Avoids leaking user-provided credentials into logs.         |

## Built-in Template: `parallel-planner-with-review`

This is the default Pipeline UI template.

| Stage     | Prompt                 | Worktree                 | Agent                     | Structured output    |
| --------- | ---------------------- | ------------------------ | ------------------------- | -------------------- |
| Planner   | planner prompt         | planner worktree         | planner agent             | `<plan>`             |
| Implement | implementer prompt     | task worktree            | implementer agent         | optional `<promise>` |
| Review    | reviewer prompt        | same task worktree       | reviewer agent            | optional `<promise>` |
| Merge     | merger prompt          | iteration merge worktree | merger agent              | optional `<promise>` |
| Verify    | verify commands/prompt | merge worktree           | command or verifier agent | command result       |

Closure rule:

- The merge stage receives `CLOSE_TASK_COMMAND`.
- After merging branches and running the template-required tests, the merger closes each merged issue.
- The next planner iteration starts only after the closure gate is satisfied for merged issues.

## Built-in Template: `sequential-reviewer`

This template matches Sandcastle's RALPH-style loop. It is available as an explicit strict mode when the user wants one issue verified, committed, and closed before the next issue starts.

| Stage     | Prompt             | Worktree      | Agent             | Structured output    |
| --------- | ------------------ | ------------- | ----------------- | -------------------- |
| Implement | RALPH implementer  | task worktree | implementer agent | optional `<promise>` |
| Review    | reviewer prompt    | same worktree | reviewer agent    | optional `<promise>` |

Closure rule:

- Each outer iteration handles one issue.
- The implementer receives `LIST_TASKS_COMMAND` and `CLOSE_TASK_COMMAND`.
- The implementer must verify, commit, and close the issue before the next issue iteration starts.
- If the issue remains open, the template does not treat that issue as complete.

## Multi-Iteration Rules

| ID       | Rule                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| C-ITER-1 | `maxIterations` is required at run time after template default resolution.                                                          |
| C-ITER-2 | Each iteration snapshots task source output before planning.                                                                        |
| C-ITER-3 | After merge and verify, Pipeline re-runs planner if `iteration < maxIterations`.                                                    |
| C-ITER-4 | If planner returns zero issues, run completes cleanly.                                                                              |
| C-ITER-5 | If an iteration produces no branches with commits, Pipeline either re-plans once or stops according to template `noProgressPolicy`. |
| C-ITER-6 | Planner branch names must be deterministic for the same source task.                                                                |

## Template Selection Rules

| ID     | Rule                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| C-TPL-1 | Pipeline UI defaults to `parallel-planner-with-review`.                                                |
| C-TPL-2 | Pipeline UI and CLI may select `sequential-reviewer` for strict one-issue-at-a-time closure.           |
| C-TPL-3 | Both built-in templates use the same PRD-labeled GitHub task source and active run reservation rules. |
| C-TPL-4 | `sequential-reviewer` does not expose per-issue hand selection; it still chooses from the PRD ready task set. |
| C-TPL-5 | Orca never auto-switches between built-in templates based on task count, dependency shape, failure history, or PRD work set size. |
| C-TPL-6 | `sequential-reviewer` forces `maxConcurrent = 1`; UI and CLI must not let the user override it. |

## Task Source Adapter Contract

```ts
type PipelineTaskSource =
  | {
      type: 'github_issues'
      provider: 'github'
      owner: string
      repo: string
      prdIssueNumber: number
      pipelinePrdLabel: string
      state: 'open'
    }
  | { type: 'manual'; tasks: { id: string; title: string; body: string }[] }
  | { type: 'custom-command'; command: string; cwd: string; disabledByDefault: true }
```

GitHub source rules:

- The adapter must list only issues with `state=open`, `task-slice`, `ready-for-agent`, and `pipelinePrdLabel`.
- `pipelinePrdLabel` is required and is the run's PRD task boundary.
- `pipelinePrdLabel` must be exactly `pipeline:prd-<prdIssueNumber>`, for example `pipeline:prd-2`.
- Starting task execution must not remove `ready-for-agent` or add `in-progress` / `claimed` labels. Pipeline uses the active run reservation as its execution lock and uses issue closure as task completion.
- The parent PRD issue must be `open` before launch. If the PRD is closed, the adapter must reject the run before listing or planning tasks.
- Before planning, every selected task issue must reference `prdIssueNumber` as its parent PRD. A mismatch fails the run before any agent starts.
- User-facing UI and CLI input must not narrow the run by individual issue numbers.
- Pipeline PRD labels are added when task-slice issues are created during `/e2e-slices` / `to-issues`, or repaired during `/e2e-triage` before the issue is considered Pipeline-runnable. Pipeline launch validates labels but does not add them.

v1 enabled source:

- GitHub issues in `Nikolatesla-lj/orca`.

UI source rule:

- Automations Pipeline UI creates `github_issues` sources only. It must not create manual task sources.
- The UI normally lets the user pick a recent PRD candidate and derives `pipeline:prd-<number>`. Manual fallback accepts only the PRD issue number.

CLI source rule:

- Pipeline CLI creates the same `github_issues` source shape as the UI. It must not expose a user-facing `--issue-numbers` narrowing option.
- Pipeline CLI derives the internal Pipeline PRD label from `--prd-issue`.

v1 deferred source:

- `custom-command`, because it is powerful and harder for beginner users to reason about safely.

## Prompt-to-Stage Traceability

| Requirement | Prompt contract           | Stage                |
| ----------- | ------------------------- | -------------------- |
| R1-R3       | C-OUT-1..6                | Planner              |
| R4-R6       | C-PROMPT-1..7             | Planner, Implement   |
| R7          | C-PROMPT-1..7, C-SEC-1..8 | Merge, Verify        |
| R8          | C-ITER-1..6               | Run loop             |
| R10         | C-SEC-1..8                | All prompt expansion |
| R22         | C-PROMPT-6..7             | Closure-capable stages |
| R23-R24     | C-TPL-1..6                | Template selection   |
