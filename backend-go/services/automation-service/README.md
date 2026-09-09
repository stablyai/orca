# automation-service

See [`specs/backend-go/services/automation-service.md`](../../../specs/backend-go/services/automation-service.md)
for the full design and
[`../usage-service/README.md`](../usage-service/README.md) for the Phase 0
pilot every service's package layout follows.

## What makes this service different

`automation-service` owns schedule/trigger definitions and run history, but
it **never executes a step itself** — `RunNow` delegates to
`workflow-service.ExecuteAdHocStep` over a real gRPC call. This is the whole
point of the service's design, not an incidental detail: TS's
`AutomationService.runNow` never had a working dispatcher wired
server-side, so every triggered run resolved `skipped_unavailable` in
production. This scaffold closes that gap for real.

**This is the one service in the current scaffold set where the key
cross-service call is REAL, not stubbed.** `internal/adapter/grpcclient/workflow_client.go`
constructs an actual `grpc.ClientConn` to `workflow-service` (dialed once in
`cmd/server/main.go`, address from `WORKFLOW_SERVICE_ADDR`) and calls
`workflowv1.NewWorkflowServiceClient(conn).ExecuteAdHocStep(...)` for real —
it imports the actual generated `workflow-service` proto types
(`github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1`), not a
hand-rolled interface pretending to be one. Both services' proto contracts
already exist in this repo (`proto/orca/automation/v1`,
`proto/orca/workflow/v1`), which is what makes a real client possible here
even though `workflow-service` isn't actually running when this service's
own tests execute in isolation — `internal/usecase`'s tests fake the
`WorkflowStepExecutor` port instead of standing up a live `workflow-service`.
A true end-to-end integration test (this service's real gRPC client talking
to a real running `workflow-service`) would need docker-compose wiring for
both services — out of scope for this scaffold's automated test suite, but
the client code that would make that call is real and compiles against the
real generated types today.

## What's implemented

- `internal/domain/` — `Automation`/`AutomationRun` entities with
  invariant-enforcing constructors and an explicit run status state machine
  (`pending -> running -> succeeded|failed`), plus `RecurrenceRule` — a pure
  value object over `github.com/teambition/rrule-go` implementing
  `NextOccurrenceAfter`/`LatestOccurrenceAtOrBefore` per the design doc's
  §4. `go get github.com/teambition/rrule-go` fetched cleanly and covers
  every recurrence feature the design doc calls out (frequency, interval,
  byweekday, count/until), so the hand-rolled "every N hours" fallback the
  task allowed for was not needed.
- `internal/usecase/` — `CreateAutomation`, `RunNow` (the core interactor),
  `ListRuns`, `HandleExternalTrigger` (thin wrapper around `RunNow`, see
  above), each tested against in-memory fakes, no real Postgres/gRPC
  needed. `RunNow`'s tests use a fake `WorkflowStepExecutor` to verify it's
  called with the right `step_config_json`/`step_type`/`tenant_id`/
  `request_id`, that a retried call with the same `request_id` returns the
  existing run without a second dispatch, and that a workflow-service
  failure is recorded as a `failed` run rather than silently swallowed.
  `CreateAutomation`'s tests cover structural `step_type` persistence,
  `enabled` defaulting, `dtstart`/`timezone` resolution, and the first
  `next_run_at` computation.
- `internal/adapter/postgres/` — real `pgx`-backed repositories for both
  `automations` and `automation_runs`, plus `AutomationRepository.ClaimDue`
  (`usecase.DueAutomationClaimer`) — the `SELECT ... FOR UPDATE SKIP LOCKED`
  scheduler claim query, covered by real-Postgres integration tests
  (`-tags=integration`) for both the claim-and-advance path and the
  concurrent-claim SKIP LOCKED behavior.
- `internal/adapter/scheduler/` — the in-process ticker loop (§7): claims
  due automations, dispatches each through `usecase.RunNow`
  (`trigger=scheduled`), advances `next_run_at`. Unit-tested against fake
  `DueAutomationClaimer`/`ClaimedBatch`/`WorkflowStepExecutor` — no real
  Postgres needed for the ticker's own dispatch/advance/idempotency logic.
- `internal/adapter/grpcclient/workflow_client.go` — the real
  `WorkflowStepExecutor` implementation described above.
- `internal/adapter/grpc/` — implements the generated
  `automationv1.AutomationServiceServer` (including `HandleExternalTrigger`
  now), pure wire<->usecase translation, plus the `StepType` enum
  translation to/from `orca.workflow.v1.StepType`.
- `migrations/0001_init.{up,down}.sql` — `automation.automations`,
  `automation.automation_runs`, RLS policies, and the `(tenant_id,
  request_id)` unique index on `automation_runs` — the same idempotency
  pattern usage-service uses for `(tenant_id, request_id)` on `sessions`.
- `migrations/0002_scheduler_columns.{up,down}.sql` — adds
  `automations.step_type`/`enabled`/`timezone`/`next_run_at` (`dtstart`
  already existed), the partial `idx_automations_due` index matching the
  scheduler's claim query, and `automation_runs.trigger`
  (`scheduled`/`manual`/`external`).
- `cmd/server/main.go` — composition root: config load, Postgres pool, a
  real `grpc.NewClient` connection to `workflow-service`, gRPC server with
  the shared interceptor chain, the scheduler ticker goroutine,
  health/readiness HTTP server (including a `workflow-service`
  connection-state readiness check), graceful shutdown (drains gRPC, then
  waits for the ticker's in-flight tick to finish).

## Quan hệ với automation TS (Electron/Node) — không phải 3 bản triplicate

An earlier audit (2026-09-09, before `docs/crs/v4/automations/CR-AUTO-001`
was corrected) concluded this service had "no real users" because the
renderer never called it. That conclusion was wrong — re-read directly
against `frontend/src/renderer/src/components/automations/automation-host-client.ts`
and `runtime-rpc-client.ts` before repeating it. The real architecture is
two independent axes, not three duplicate implementations:

1. **Deployment target** (mutually exclusive, picked at build/run time):
   Electron desktop uses `desktop/src/main/automations/service.ts`; Node
   "server mode" uses `backend/src/main/automations/` (Postgres via
   `pg-automation-store.ts`). Both sit behind `window.api.automations.*`
   when the renderer's target is `{kind: 'local'}` — which TS backend
   answers depends only on which build the renderer is talking to.
2. **Pairing** (orthogonal to axis 1): whenever the renderer has an
   `activeRuntimeEnvironmentId` set (paired to a remote dev
   server/runtime environment), `automation-host-client.ts` routes
   `automation.list`/`.create`/`.update`/`.delete`/`.runs`/`.runNow`
   through `callRuntimeRpc` → `window.api.runtimeEnvironments.call` →
   this service's gRPC server via `api-gateway`'s wscompat
   `channels_automation_task.go` — **this service is the only backend on
   that path**, regardless of which TS deployment target axis 1 picked.

`workflow-service`'s dispatch (`internal/adapter/infrafleetclient/relay_client.go`)
confirms this service isn't structurally limited to "local" targets the
way the Electron scheduler is (`desktop/src/main/automations/run-target-resolution.ts:41-50`
explicitly blocks remote dispatch there) — `relay()` forwards to whatever
`connectionID` the step config names, with no target-kind branching. This
service's scheduler is Postgres-backed and process-lifetime-independent,
which is why it's the natural home for automation that must run whether
or not any particular Electron/Node process is up.

## Running locally

```sh
# from backend-go/
docker compose up -d postgres   # see ../../docker-compose.yml
migrate -path services/automation-service/migrations \
  -database "$DATABASE_DSN" up  # golang-migrate; see architecture/05

cd services/automation-service
DATABASE_DSN=postgres://orca:orca@localhost:5432/automation?sslmode=disable \
WORKFLOW_SERVICE_ADDR=localhost:9091 \
SCHEDULER_INTERVAL=1m \
SCHEDULER_BATCH_SIZE=50 \
  go run ./cmd/server
```

`SCHEDULER_INTERVAL`/`SCHEDULER_BATCH_SIZE` are optional (default `1m`/`50`
— see `internal/config/config.go`).

## Testing

```sh
go test ./...                 # unit tests (domain/, usecase/) — no external deps
go test -tags=integration ./internal/adapter/postgres/...   # requires Docker (testcontainers-go)
```

## Deviations from the design doc (and why)

The generated proto (`proto/orca/automation/v1/automation.proto`, which this
service must not regenerate) is deliberately smaller than the design doc's
§3/§4/§5 sketch — it ships 4 RPCs (`CreateAutomation`, `RunNow`,
`ListRuns`, `HandleExternalTrigger`) and a minimal `Automation` message
(`id`, `tenant_id`, `name`, `rrule`, `step_config_json`, `step_type`,
`enabled`, `dtstart`, `timezone`), not the full CRUD surface or the richer
`Automation`/`AutomationRun` field sets (`project_id`, `agent_id`,
`execution_target`, `workflow_execution_id`, `missed_run_policy`, etc.) the
design doc describes. This scaffold builds strictly against the proto that
exists, per the task's constraints, and notes the gaps here rather than
silently matching the doc's aspirational shape:

- **`tenant_id` on the wire is ignored in favor of context.** Both
  `Automation` and `CreateAutomationRequest` carry a `tenant_id` field, but
  per `architecture/05-data-architecture.md`'s tenant-isolation rule
  ("never trusted from the request body"), `CreateAutomation`'s usecase
  pulls `tenant_id` from `context` (populated by `grpcmw`'s tenant-extraction
  interceptor from caller metadata) — the same pattern
  `usage-service.RecordUsageSession` uses. `RunNow`/`ListRuns`'s requests
  don't carry `tenant_id` at all, consistent with this.
- **`step_type` is now a first-class stored column, not JSON-blob-derived.**
  The generated proto grew a `step_type` field (`Automation`/
  `CreateAutomationRequest`, reusing `orca.workflow.v1.StepType`), and
  migration `0002_scheduler_columns` adds an `automations.step_type` column
  to match. `domain.NewAutomation` defaults it to `agent` when unspecified,
  `internal/adapter/grpc/server.go` translates the wire enum to/from
  `domain.StepType`, and `RunNow` dispatches the stored column directly —
  the old `domain.ParseStepType` (which read a `"step_type"` key out of
  `step_config_json`) is removed; `step_config_json` now carries only
  type-specific config.
- **`dtstart`/`timezone`/`next_run_at` + the scheduler loop are now real.**
  `internal/adapter/scheduler/` is an in-process ticker (default 1 minute,
  `SCHEDULER_INTERVAL`/`SCHEDULER_BATCH_SIZE` env-configurable) started as a
  goroutine from `cmd/server/main.go`. Each tick claims due automations
  (`enabled = true AND next_run_at <= now()`) via
  `AutomationRepository.ClaimDue`'s `SELECT ... FOR UPDATE SKIP LOCKED`
  (migration `0002_scheduler_columns` adds `enabled`, `timezone`,
  `next_run_at`; `dtstart` already existed from `0001_init`), so concurrent
  replicas never double-dispatch the same due row. Each claimed row is
  dispatched through the SAME `usecase.RunNow` interactor the gRPC handler
  uses (`trigger=scheduled`, a request_id deterministically derived from
  `(automation_id, next_run_at)` for at-least-once idempotency), then
  `next_run_at` is advanced via `RecurrenceRule.NextOccurrenceAfter` and
  persisted within the same claim transaction — held open across dispatch
  deliberately, so a crash before commit leaves the row due again on the
  next tick instead of silently skipping it (§8's "a missed tick must not
  silently drop a run"). `CreateAutomation` populates all four columns from
  the proto fields (`dtstart` empty → now; `timezone` empty → UTC) and
  computes the first `next_run_at` from `rrule`+`dtstart` at creation time.
- **`HandleExternalTrigger` is implemented**, mapping
  `HandleExternalTriggerRequest` onto the same `RunNow` interactor
  (`usecase.HandleExternalTrigger`, `trigger=external`, the external
  source's own `request_id` used verbatim for idempotency — never internally
  minted). `payload_json` is accepted on the wire but not interpreted or
  persisted (the proto comment documents it as opaque pass-through) — no
  per-source payload mapping is implemented. §9's webhook
  authentication (shared secret/signature) is also NOT implemented — that
  remains true for any future public webhook caller (see
  `BE-AUTO-SOL-007`, separate CR).
  **Auth status (TASK-BE-AUTO-008, 2026-09-09)**: a service-local
  interceptor (`internal/adapter/grpc/interceptors`) now gates this one RPC
  — a request with no tenant identity is rejected with `PermissionDenied`
  before the usecase layer runs, instead of only failing later inside
  `RunNow`. This does NOT add a distinct "service-to-service caller
  identity" check: TASK-BE-AUTO-008's own investigation found no reusable
  mTLS/service-identity pattern anywhere in `backend-go` (the one
  candidate, `credential-broker-service`'s `x-orca-service-id` header, is
  itself documented as non-production and unset by every caller in the
  codebase), and `api-gateway`'s `POST /automations/{id}/trigger` route
  (TASK-BE-AUTO-012) already reaches this RPC with the same
  identity-validated, tenant-scoped access every other automation RPC
  requires — cross-tenant triggering was already impossible before this
  task, same posture as `RunNow`/`ListAutomations`/etc. CR-AUTO-005's
  original internal callers (agent-completion signal, PR-merged) still
  don't exist in the codebase; when one is built it should define its own
  real caller-identity requirement rather than reuse a guessed-in-advance
  one. See
  `specs/backend-go/crs/v4/automations/tasks/TASK-BE-AUTO-008-external-trigger-auth.md`'s
  "Kết quả thực tế" for the full investigation.
- **No `project-service` call.** §7/§9 describe `RunNow` re-resolving the
  owning user's current project access via `project-service` before every
  dispatch. `project-service`'s generated client isn't wired into this
  scaffold — `RunNow` here trusts the caller's already-validated tenant
  context (same trust boundary every other service in this scaffold set
  uses) rather than re-checking authorization per dispatch. Flagged, not
  silently dropped: revisit once `project-service`'s gRPC surface is stable
  enough to depend on.
- **`UpdateAutomation`/`DeleteAutomation`/`ListAutomations` RPCs exist and
  are implemented** (`internal/adapter/grpc/server.go`, added in commit
  `3df9da8b1`, 2026-08-25) — a previous revision of this README claimed
  they were absent from the generated proto; that was stale (the README
  was last touched at `0e7092d18`, 2026-08-18, before those RPCs landed).
  As of 2026-09-09 (TASK-BE-AUTO-012) all three also have REST routes in
  `api-gateway`'s `automation_routes.go` (`GET /v1/automations/`,
  `PATCH /v1/automations/{id}`, `DELETE /v1/automations/{id}`), matching
  the 4 routes that already existed. **`GetAutomation` (single-automation
  fetch by id) remains genuinely absent** — no proto RPC, no REST route;
  `ListAutomations` is the only fetch path today. Add it if/when a real
  caller needs fetch-by-id instead of list+filter — not added speculatively.
- **`apperrors.Kind` has no `Unavailable` value.** §8 asks for `RunNow` to
  "fail closed with `UNAVAILABLE`" when `workflow-service` is unreachable.
  `common/apperrors` (which this service must not modify) only defines
  `KindNotFound`/`KindAlreadyExists`/`KindInvalidArgument`/
  `KindPermissionDenied`/`KindFailedPrecondition`/`KindUnauthenticated`/
  `KindInternal`. A workflow-service transport failure is mapped to
  `KindInternal` with `Code: "AUTOMATION_WORKFLOW_UNAVAILABLE"` instead —
  the gRPC status code ends up `codes.Internal` rather than
  `codes.Unavailable`, but the run is still recorded `failed` and the error
  is never swallowed, which is the behavioral guarantee §8 actually cares
  about.
- **No `sqlc` codegen wired**, same as usage-service — hand-written `pgx`
  SQL is a valid destination per `architecture/04-tech-stack.md` but not
  yet the codegen-checked default path.
- **`common/secrets` (Vault) and `common/tracing`'s OTLP exporter** are not
  wired here either, matching usage-service's own noted gaps.
