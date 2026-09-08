# BACKLOG-009: `orchestration-service` has no real caller for its new `FailDispatch` RPC yet

**Origin:** `specs/backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-011-dispatch-failure-classification.md` and `TASK-BE-STORAGE-012-explicit-teardown-and-integration-tests.md` (BE-SOL-STORAGE-003, CR-STORAGE-008b)
**Priority:** Low-Medium (downgraded from Medium) — the circuit-breaker mechanism itself is now real and tested; what remains is only "who calls it", a narrower question than before
**Blocked on:** Which component actually attempts a dispatch/relay-to-agent call that can fail — not found anywhere in backend-go in this session's investigation (see "Update 2026-09-08" below); needs that traced before a real caller can be wired in

---

> **Update 2026-09-08:** User confirmed the circuit-breaker is wanted
> ("Cần circuit-breaker dispatch failure"). Built the previously-missing
> piece for real, per this file's own §"What NOT to do" guidance (don't
> invent a speculative dispatcher loop — build the well-scoped RPC itself,
> leave the caller question open):
>
> - **New `FailDispatch` RPC** (`orchestration.proto`): takes
>   `dispatch_context_id` + the caller's own failed call's
>   `error_message`/`grpc_status_code`, reconstructs a comparable error, and
>   calls the already-existing `ClassifyDispatchFailure` — a transport
>   failure (`UNAVAILABLE`/`DEADLINE_EXCEEDED`) is classified and
>   intentionally **not** recorded (`recorded=false`, context unchanged); any
>   other failure calls the new `DispatchContextRepository.RecordDispatchFailure`
>   (locked read + `domain.DispatchContext.RecordFailure` + persist,
>   transactional), which trips `circuit_broken` at `failure_count >= 3`
>   exactly as `orchestration-service.md §4` specifies.
> - New: `usecase.FailDispatch` (+ 6 tests, all passing — real failure
>   records, transport failure doesn't, threshold trips the breaker,
>   not-found, empty-id, no-tenant), `Repository.RecordDispatchFailure`,
>   wired into `cmd/server/main.go` and the gRPC server.
> - `go build`/`go vet`/`go test` clean for both `orchestration-service` and
>   `api-gateway` (its two `OrchestrationServiceClient` test fakes embed the
>   interface, so the new method didn't require touching them).
> - **Investigated "who calls it" and did NOT find an answer** — see this
>   file's original analysis below, still accurate: `orchestration-service`
>   has no outbound gRPC client to `infra-fleet-service`/anywhere, and no
>   component anywhere in backend-go was found that makes an actual
>   dispatch/relay-to-agent call tied to a `DispatchContextID` that could
>   fail and report back here. The real agent-dispatch subsystem this would
>   hook into doesn't appear to exist yet in `backend-go` (may still be
>   TS-only, or not yet built for this architecture) — **that's the
>   remaining gap**, now isolated to just this one question instead of also
>   needing the RPC itself designed and built.

---

## What this is

CR-STORAGE-008(b) designed a rule: when a dispatch to a dev-server agent
fails while the underlying `connections` row is merely `degraded` (a
transient network blip, not a real disconnect), the failure should **not**
be counted toward `dispatch_contexts.failure_count`/circuit-breaking —
only a failure while the connection is genuinely `established` (a real
execution error) or `closed` (grace period expired, no more retries
possible) should count. `TASK-BE-STORAGE-011` was supposed to add this
classification gate in front of the real `FailDispatch` call site.

## Why it's blocked (confirmed by reading the real code, not guessed)

`TASK-BE-STORAGE-011` searched exhaustively and found **`FailDispatch`
does not exist anywhere in `orchestration-service`** — not as a proto RPC,
not as a usecase, not as a gRPC handler:

- `grep -rn "FailDispatch" backend-go/` → 3 hits, all comments, zero
  definitions.
- `orchestration-service/README.md`'s own "Known gaps" section already
  documents this: `FailDispatch`/`RecordHeartbeat`/`FailCoordinatorRun`
  "are not in the generated proto, so no RPC/usecase exists for them."
- `gitnexus impact({target:"FailDispatch"})` → "Target not found."
- The closest real thing, `domain.(*DispatchContext).RecordFailure`
  (a pure domain method that increments `failure_count` and flips to
  `circuit_broken` past the threshold), has **zero callers** anywhere in
  the codebase (`impactedCount: 0`).
- `orchestration-service` also has **no gRPC client wiring to
  `infra-fleet-service` at all** (`grep -rln "infrafleet"` → empty), so
  even once `FailDispatch` exists, it has no way to check the caller's
  `connections.status` without a new cross-service call.

So the entire premise — "gate the existing FailDispatch call site" — has
nothing to gate. `TASK-BE-STORAGE-011` implemented the classification
function itself anyway (`ClassifyDispatchFailure(err error) FailureOrigin`,
`backend-go/services/orchestration-service/internal/usecase/classify_dispatch_failure.go`),
using standard gRPC status codes (`Unavailable`/`DeadlineExceeded`) as the
best available transport-failure signal, but documented that it has no
caller — it's ready to be wired in once something exists to wire it into.

## What NOT to do

Don't invent a `FailDispatch` RPC/usecase/dispatcher-loop just to have
something to call `ClassifyDispatchFailure` from — that's a significant,
unscoped feature addition (how dispatch failures get reported and by whom
is a real design question: does the agent report failure, does a
supervisor loop poll and time out, does `task-service` decide?), not a
"finish the task" wiring job. `TASK-BE-STORAGE-011`/`012` both stopped
here rather than build that speculatively.

## The decision needed

Someone who owns the dispatch/execution lifecycle in `orchestration-service`
needs to design (not just implement) how a dispatch failure is actually
detected and reported today, then decide:

1. **Does a `FailDispatch` RPC/usecase need to exist at all yet?** If
   nothing currently reports dispatch failures, `RecordFailure`/
   `failure_count`/`circuit_broken` may be unused scaffolding from an
   earlier design pass — worth confirming before building more on top of
   it.
2. **If yes, who calls it** — the dev-server agent itself (needs an
   inbound RPC), a supervisor/timeout loop in `orchestration-service`
   (needs to exist), or is failure inferred indirectly from
   `infra-fleet-service`'s `connections`/`terminal_sessions` state (needs
   the missing outbound gRPC client noted above)?
3. **Once that's decided**, wire `ClassifyDispatchFailure` in at the real
   call site exactly as `TASK-BE-STORAGE-011` intended.

## Once decided

- Implement the real `FailDispatch` path per the chosen design.
- Call `ClassifyDispatchFailure` (already written and tested) at that call
  site before incrementing `failure_count`.
- Revisit `TASK-BE-STORAGE-012`'s two reframed tests
  (`TestDegradedConnectionDoesNotTripCircuitBreaker`,
  `TestGracePeriodExpiryClosesConnectionAndTerminalSessions`) and add the
  genuinely end-to-end version once a real call site exists — the current
  versions only prove the `infra-fleet-service`-side pieces (connection
  state machine, terminal session closing) behave correctly in isolation.
