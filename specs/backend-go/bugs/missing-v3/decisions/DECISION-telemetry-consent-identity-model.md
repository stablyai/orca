# DECISION NEEDED: telemetry.track's consent + identity model for a multi-tenant server product

**Blocks:** BUG-014 / SOL-014 implementation (TASK-016, TASK-017, TASK-018
in `../tasks/`). **Owner:** product/privacy, not backend-go engineering —
see SOL-014's "Why this is a product decision, not an engineering gap"
section for the full reasoning this doc summarizes into concrete questions.
**Status:** 🔴 UNDECIDED

## Question 1 — Identity: what is `distinctId`?

The old desktop backend uses a per-**installation** anonymous UUID
(`install_id`, generated once, persisted locally) specifically so PostHog
never correlates events to a real user identity. backend-go has no
"installation" concept — every session is a real, identifiable
`(tenant_id, user_id)` pair.

- **Option A — per-`(tenant_id, user_id)` pseudonymous hash** (SOL-014's
  assumed default for its sketch): closer to the old anonymous-install
  model; still technically re-identifiable by whoever controls the hash
  salt, unlike a true anonymous install ID.
- **Option B — raw `user_id` as `distinctId`**: simplest to implement,
  but is a materially different privacy posture (named-user analytics)
  than the desktop product ships today — the exact kind of silent change
  `missing-v1/SOL-007` flagged as needing explicit sign-off.
- **Option C — no `distinctId` correlation at all** (event-only, no
  per-user timeline in the analytics vendor): weakest analytics value,
  strongest privacy default.

**Decision:** _______________

## Question 2 — Consent: per-user, per-tenant, or both?

The old backend reads one **local machine's** opt-in/opt-out. A
multi-user server deployment has no single obvious equivalent.

- **Option A — per-user opt-in/opt-out** (SOL-014's assumed default),
  stored on `tenant-service`'s `UserProfile` (mirrors SOL-005's
  `star_nag_state` precedent for small per-user preference state).
- **Option B — per-tenant admin toggle** covering every user in that
  tenant, no individual override.
- **Option C — both, with an explicit precedence rule** (e.g. tenant
  opt-out always wins over a user's individual opt-in; or the reverse).

**Decision:** _______________

## Question 3 — Build-identity gating: does backend-go need an equivalent?

`IS_OFFICIAL_BUILD`/`ORCA_BUILD_IDENTITY`/`ORCA_POSTHOG_WRITE_KEY` gate
telemetry to specific CI-built desktop binaries. backend-go ships one
server binary, not a contributor/rc/stable build matrix.

- **Option A — no equivalent needed**; gate only on consent (Question 2)
  and a single environment-level "is telemetry enabled for this
  deployment at all" flag (e.g. self-hosted on-prem installs may want
  telemetry off entirely, independent of any user's personal consent).
- **Option B — some other environment/deployment-tier gate** (name it
  here if chosen).

**Decision:** _______________

## Question 4 — Cohort enrichment: v1 scope-cut or invest now?

`getCohortAtEmit()`/`getOnboardingCohortAtEmit()` read live local state
(repo count, onboarding progress) to attach cohort tags. That data exists
in backend-go across several services; reading it synchronously on every
`telemetry.track` call would add cross-service calls to a path every
current frontend call site already treats as fire-and-forget/non-fatal.

- **Option A — drop cohort enrichment from the v1 cut** (SOL-014's
  assumed default) — coarser analytics, no new cross-service calls on
  this path.
- **Option B — invest in it now**, and additionally decide which service
  owns the onboarding/repo-count read this would need (unsettled today
  per SOL-014's own "Where this would live" section).

**Decision:** _______________

## Once every question above has a recorded decision

Update this document's Status to `✅ DECIDED (<date>)`, fill in every
`Decision:` line, and un-block TASK-016/017/018 by updating each of their
`**Depends on:**` lines to point at this file's decided state instead of
"blocked." Do not begin implementing TASK-016/017/018 before every question
above has an explicit answer — even a fast/lightweight decision on each is
better than an engineering guess that turns out to be the wrong-by-default
option SOL-014 warns about.
