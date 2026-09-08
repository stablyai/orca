# BACKLOG-005: `telemetry.track` — pick a consent/identity model for backend-go, then implement it

**Origin:** `specs/backend-go/bugs/missing-v3/BUG-014-telemetry-track-no-op.md`, `specs/backend-go/bugs/missing-v3/solutions/SOL-014-telemetry-track.md`, decision doc at `specs/backend-go/bugs/missing-v3/decisions/DECISION-telemetry-consent-identity-model.md` (full detail — this file summarizes it)
**Priority:** Low until decided — genuinely blocked on a human call, not on engineering time
**Blocked on:** **A product/privacy decision**, not `agent/` or any missing backend capability
**Owner:** product/privacy, not backend-go engineering

---

## What this is

`telemetry.track` is registered in `wscompat` and every call to it
succeeds, but the handler's entire body is `return nil, nil` — the event
payload is never decoded, and there's no analytics backend anywhere in
`backend-go` to forward to. This is a **deliberate** interim decision (the
file's own doc comment says so), not an oversight: the old TS backend
forwarded these events to PostHog with real consent-gating and cohort
enrichment, and porting that faithfully raises questions that don't have an
obvious answer in a multi-tenant server architecture, unlike the old
per-installation desktop model.

## The 4 questions that need an answer before any of this is built

**1. Identity — what is `distinctId`?** The old model uses a per-
*installation* anonymous UUID so PostHog never correlates events to a real
user. backend-go has no "installation" concept — every session is a real
`(tenant_id, user_id)` pair.
- Option A: per-`(tenant_id, user_id)` pseudonymous hash (closer to the old
  anonymous-install model, but re-identifiable by whoever holds the salt).
- Option B: raw `user_id` (simplest, but a materially different, named-user
  privacy posture than the desktop product ships today).
- Option C: no `distinctId` correlation at all (event-only, no per-user
  timeline; weakest analytics value, strongest privacy default).

**2. Consent — per-user, per-tenant, or both?** The old model reads one
local machine's opt-in/opt-out; a multi-user server has no single obvious
equivalent.
- Option A: per-user opt-in/opt-out (stored on `tenant-service`'s
  `UserProfile`, mirroring the small-per-user-preference precedent
  `starNag.*`'s `star_nag_state` table already set).
- Option B: per-tenant admin toggle covering everyone in that tenant.
- Option C: both, with an explicit precedence rule (which wins?).

**3. Build-identity gating — does backend-go need an equivalent?** The old
model gates telemetry to specific CI-built desktop binaries
(`IS_OFFICIAL_BUILD`/`ORCA_BUILD_IDENTITY`). backend-go ships one server
binary, not a contributor/rc/stable build matrix.
- Option A: no equivalent needed — gate only on consent (Q2) plus a single
  environment-level "is telemetry on for this deployment at all" flag (some
  self-hosted/on-prem installs may want it fully off).
- Option B: some other environment/deployment-tier gate (name it if chosen).

**4. Cohort enrichment — v1 scope-cut or invest now?** The old model reads
live local state (repo count, onboarding progress) to attach cohort tags on
every event. That data exists across several backend-go services; reading
it synchronously on a path every current frontend call site treats as
fire-and-forget/non-fatal would add new cross-service calls.
- Option A: drop cohort enrichment from the v1 cut — coarser analytics, no
  new cross-service calls.
- Option B: invest in it now, and decide which service owns the
  onboarding/repo-count read this would need (currently unsettled).

## What happens once this is decided

Three small, already-scoped follow-up tasks are ready to execute the moment
these questions have answers (kept in
`specs/backend-go/bugs/missing-v3/tasks/`, currently `[ ] TODO — blocked`):

- **TASK-016** — add the chosen consent field to `tenant-service`.
- **TASK-017** — a Go event allowlist (validating `{name, props}` against a
  known set, mirroring the old `telemetry-events.ts` Zod schemas).
- **TASK-018** — the actual stateless forwarding handler in `api-gateway`,
  replacing today's `return nil, nil`, following the old client's
  consent→validate→capture ordering.

None of these should be started, or defaulted through with a guessed
"reasonable" answer, before Questions 1–4 above have a recorded decision —
record it in `specs/backend-go/bugs/missing-v3/decisions/DECISION-telemetry-consent-identity-model.md`
(flip its Status to `✅ DECIDED (<date>)` with each answer filled in), then
pick up TASK-016/017/018 in that directory.
