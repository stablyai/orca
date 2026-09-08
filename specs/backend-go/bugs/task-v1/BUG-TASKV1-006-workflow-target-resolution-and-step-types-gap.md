# BUG-TASKV1-006: Workflow steps still carry a raw `connectionId` — no `project:<id>`/`server:<id>`/`fleet:tag:<tag>` resolution, and `action`/`parallel` step types still don't exist

**Business Logic:** [BL-WF-02](../../../../docs/logic/workflow-orchestration/BL-WF-02-workflow-execution.md) — Multi-Server Workflow Execution
**Service:** `workflow-service`
**File:** `backend-go/services/workflow-service/internal/domain/step.go`
**Priority:** P1
**Status:** PARTIAL
**Severity:** High
**Symptom:** A workflow step's config still carries a raw dev-server `ConnectionID` the caller must resolve and supply themselves — the orchestrator does no cross-server dispatch decision-making of its own. Only 5 step types exist (`agent`, `shell`, `notification`, `webhook`, `condition`); there is still no `action` type and no `parallel` type at all.

---

## Spec summary

BL-WF-02 specifies dynamic per-step target resolution — `"project:<id>"` (the project's currently bound dev server), `"server:<id>"` (direct passthrough with validation), `"fleet:tag:<tag>"` (healthy-server load balancing across a tagged pool) — plus 6 step types (`agent`, `shell`, `action`, `webhook`, `parallel`, `condition`) and `{{...}}` variable interpolation from run inputs and prior-step outputs.

## What backend-go has (confirmed current)

- `StepType` (`backend-go/services/workflow-service/internal/domain/step.go:14-22`) is confirmed still a closed 5-value enum: `StepTypeAgent`, `StepTypeShell`, `StepTypeNotification`, `StepTypeWebhook`, `StepTypeCondition` — no `StepTypeAction`, no `StepTypeParallel`. `Valid()` (`step.go:26-31`) enforces exactly these 5.
- `AgentStepConfig`/`ShellStepConfig`/`NotificationStepConfig` (per BL-WF-02's original audit, `step.go:60-89`) still carry a caller-supplied `ConnectionID` field directly — confirmed by the same file's current step-type list showing no resolver-shaped field (`project`/`server`/`fleet` target string) anywhere.
- DAG build, Kahn's-algorithm cycle detection, and the bounded-concurrency wave dispatcher remain real and unchanged (`internal/domain/dag.go`, `internal/usecase/wave_dispatcher.go`) — wave-level parallelism across independent DAG steps genuinely works; this is a different mechanism from the still-missing `parallel` step *type*.

## What's missing (re-confirmed, unchanged since prior audit)

- No server resolution logic anywhere — `grep`-confirmed zero matches across `workflow-service`, `orchestration-service`, and `infra-fleet-service` for `fleet:tag`/`ServerResolver`/`resolveServer`. A workflow only spans multiple dev servers if the caller manually puts a different `ConnectionID` into each step's config ahead of time.
- No AI provider resolution for `agent` steps — `AgentStepConfig` has `Prompt`/`WorktreePath`/`TrustPreset` only, no provider/model selection or cascading account lookup.
- No variable interpolation — `ExecuteRequest` still has no `inputs` field; no `interpolate()` equivalent exists anywhere in `workflow-service`.
- Only 5 of 6 step types exist; `action` and `parallel` remain entirely absent — confirmed by the current enum listing above, no change since the prior audit.
- No live streaming of execution events — `workflow.*` still has zero `wscompat` push-channel registrations for `step.output`/`step.completed`/`execution.completed`; clients still only get point-in-time polling via `workflow.getExecution` (now WS-wired per `channels_workflow.go:131`, but still a poll, not a push).

## See also

- [`logic-v1/BUG-WF-02-workflow-execution-partial.md`](../logic-v1/BUG-WF-02-workflow-execution-partial.md) — full original audit with complete citations; this report only re-confirms it is unchanged.
- [`logic-v1/solutions/SOL-WF-02-execution-server-provider-interpolation-streaming.md`](../logic-v1/solutions/SOL-WF-02-execution-server-provider-interpolation-streaming.md) — proposed design for server resolution, provider resolution, interpolation, and streaming.
- [`missing-v1/BUG-030-workflow-channels-not-implemented.md`](../missing-v1/BUG-030-workflow-channels-not-implemented.md) — marked ✅ Resolved; confirmed current: `channels_workflow.go` now wires 11 `workflow.*` methods (`execute`, `cancel`, `template.create/update/list/resolve`, `getExecution`, `pause`, `resume`, `hasActiveExecutions`, `executeAdHocStep`), more than that bug originally described — the WS-wiring gap it reported is closed; the deeper execution-logic gaps this bug documents are unrelated to wiring and remain open.

## References

- `backend-go/services/workflow-service/internal/domain/step.go:11-31` — `StepType` enum (5 values, no `action`/`parallel`), confirmed current
- `backend-go/proto/orca/workflow/v1/workflow.proto:56-64` — `StepType` proto enum, same 5 values
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_workflow.go:47-260` — confirms 11 `workflow.*` channels now wired (WS-wiring resolved; execution-logic gaps unrelated)
