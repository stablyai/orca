# BUG-TASKV1-002: AI Decompose only parses a bare title into proposals — no dependencies, estimates, or prompt templates

**Business Logic:** [BL-TG-02](../../../../docs/logic/task-graph/BL-TG-02-ai-task-planning.md) — AI-Assisted Task Planning & Decomposition
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/ai_decompose.go`
**Priority:** P0
**Status:** PARTIAL
**Severity:** Medium
**Symptom:** "AI: Plan this task" makes a real AI call and really commits accepted subtasks transactionally, but the AI only ever sees the task's bare title (no description/context/tech-stack), and every returned proposal carries only a `Title` — no `type`, `estimated_hours`, `depends_on`, or `prompt_template` — so `AIApply` can only ever create `parent_child` edges, never the dependency edges between sibling subtasks the spec's decomposition output implies.

---

## Spec summary

BL-TG-02 wants AI Decompose to collect task+project+tech-stack+velocity+existing-subtask context, ask an AI for a structured JSON breakdown (`{subtasks: [{title, type, estimated_hours, depends_on, prompt_template}], dependencies, notes}`), let the user review/edit, then commit accepted subtasks + `depends_on` edges on Accept. It also specifies a pure `calculateCriticalPath()` DAG algorithm and dev-server-side tech-stack detection.

## What backend-go has (confirmed current)

- `AIDecompose.Execute` (`backend-go/services/task-service/internal/usecase/ai_decompose.go:42-73`) is a real, working round-trip: resolves an AI provider via `AIProviderContextResolver`, resolves the task's project dev-server connection, relays the prompt through `AICompleter.Complete` to the Dev Server Agent, and returns proposals without writing anything until `AIApply` commits — confirmed unchanged, still a genuine external AI call, not a stub.
- `buildDecomposePrompt` (`ai_decompose.go:79-90`) still interpolates only `task.Title` plus a `providerCtx` traceability string.
- `parseSubtaskProposals` (`ai_decompose.go:98-118`) still parses a plain `"<n>. <title>"` numbered-list response and only ever populates `Title` on `domain.SubtaskProposal` — confirmed by reading the current file line-by-line: no `type`/`estimated_hours`/`depends_on`/`prompt_template` parsing exists.
- `domain.SubtaskProposal` (`backend-go/services/task-service/internal/domain/subtask_proposal.go:9-12`) is still exactly `{Title, Description}` — and `Description` is still never populated by the parser above.
- `AIApply` still only creates `parent_child` edges per proposal (confirmed: no `depends_on` field exists on `SubtaskProposal` to source a dependency edge from in the first place).

## What's missing (re-confirmed, unchanged since prior audit)

- Context collection is a single field (`task.Title`), not the spec's five-source bundle (description, `aiContext`, project/tech-stack, velocity data, existing-subtask dedup) — `domain.Task` still has no `Description`/`AIContext` field to source these from (see BUG-TASKV1-001).
- No tech-stack detection (`package.json`/`go.mod`/etc. via the dev server) anywhere in `task-service`.
- No dependency edges from AI proposals — `AIApply` always creates `EdgeKindParentChild` only.
- No "AI Generate Agent Prompt" flow, no `prompt_template` field to save one to.
- No critical-path calculation (`grep -rn "CriticalPath" backend-go/services/task-service/` returns zero hits).
- No `ai_plan_json` persistence of the raw AI response.
- No structured-JSON error handling — the parser deliberately targets plain numbered-list text, not JSON, so there is no "invalid JSON" case to detect.

## See also

- [`logic-v1/BUG-TG-02-ai-task-planning-partial.md`](../logic-v1/BUG-TG-02-ai-task-planning-partial.md) — full original audit with complete citations; this report only re-confirms none of it has changed.
- [`logic-v1/solutions/SOL-TG-02-ai-task-planning.md`](../logic-v1/solutions/SOL-TG-02-ai-task-planning.md) — proposed design (referenced by [SOL-TG-04](../logic-v1/solutions/SOL-TG-04-task-agent-execution.md) as the source of the topological-wave building blocks its batch-execution design reuses).

## References

- `backend-go/services/task-service/internal/usecase/ai_decompose.go:42-133` — `AIDecompose.Execute`, `buildDecomposePrompt`, `parseSubtaskProposals` (all unchanged)
- `backend-go/services/task-service/internal/domain/subtask_proposal.go:9-12` — `SubtaskProposal{Title, Description}` (unchanged)
- `backend-go/proto/orca/task/v1/task.proto:76-111` — `AIDecompose`/`AIApply` RPC + message definitions
