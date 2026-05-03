# Telemetry PR 1 — scope vs. the rest of the rollout

One-page summary of what this PR ships and what deliberately comes later. Full spec lives in `docs/telemetry-implementation.md` (§Rollout — 5 PRs) and `docs/telemetry-plan.md` (§Rollout).

## This PR (PR 1) — Foundation

**Zero network, zero UI, nothing transmits.** Just the types, consent resolver, cohort migration, and the privacy doc the later PRs build on. Safe to revert — removing the settings block is the only user-visible effect.

What lands:

- `GlobalSettings.telemetry` block in `src/shared/types.ts` — `optedIn`, `installId`, `existedBeforeTelemetryRelease`, banner-dismissal markers.
- One-shot migration in `src/main/persistence.ts` — keyed on `existsSync(dataFile)` so pre-telemetry installs land as `optedIn: null` (awaiting banner), fresh installs as `optedIn: true`. Runs on the corrupt-file path too.
- `src/main/telemetry/consent.ts` — pure `resolveConsent(settings)` returning a discriminated union; precedence `DO_NOT_TRACK` → `ORCA_TELEMETRY_DISABLED` → CI → store.
- `src/main/telemetry/install-id.ts` — UUID v4 generate / read / reset.
- `src/main/telemetry/cohort-resolver.ts` — post-load Case A/Case B banner state machine; writes go through `store.updateSettings()` so `flush()` on `will-quit` catches them.
- `src/main/index.ts` — wires `initCohortResolver(store)` after `Store.load()`. No `initTelemetry`, no `shutdownTelemetry` yet.
- `PRIVACY.md` at repo root + link from `README.md`.
- Tests: `consent.test.ts`, `install-id.test.ts`, `cohort-resolver.test.ts`, migration cases in `persistence.test.ts`.

## What PR 1 is *not* doing

- **No PostHog dependency.** The SDK lands in PR 2.
- **No IPC surface.** `telemetry:track` / `telemetry:setOptIn` land in PR 2.
- **No typed event map / Zod schemas.** `src/shared/telemetry-events.ts` lands in PR 2.
- **No first-launch UI.** Toast, banner, and Privacy pane land in PR 3.
- **No call sites.** `app_opened`, `agent_started`, `workspace_created`, etc. land in PR 4.
- **No dashboards.** PostHog-side configuration in PR 5.
- **No OSC-title inference in telemetry.** Shared agent-title detection stays UI/runtime-only; later telemetry call sites use explicit launch/session facts Orca owns.

## Why this split

Each PR is independently revertable. The consent + identity state has to exist *before* the transport can be wired and *well before* the UI can let a user flip a switch, because the migration's cohort tag (`existedBeforeTelemetryRelease`) is the thing PR 3's first-launch surface branches on. Landing the migration alone means existing users are silently classified correctly the moment the telemetry release reaches them, so PR 3 doesn't have to do cohort archaeology later.

Keeping PR 1 strictly no-op also means the only way telemetry could start transmitting is the explicit `TELEMETRY_ENABLED = false → true` flip in PR 3 — one-line rollback if anything goes wrong.

## The rest of the rollout in one line each

| PR | Scope | Transmits? |
|---|---|---|
| **PR 1 (this)** | Types, migration, consent resolver, install ID, PRIVACY.md | No |
| PR 2 | PostHog client, Zod event schemas, runtime validator, IPC bridge, burst cap — all behind `TELEMETRY_ENABLED = false` | No |
| PR 3 | First-launch toast + banner, Privacy pane, `TELEMETRY_ENABLED = true` | **Yes (first)** |
| PR 4 | Wire the 7 events to their call sites (`app_opened`, `agent_started`, etc.). `agent_started` records the launched `initial_agent_kind`, not a later inferred shell title. | Yes |
| PR 5a | Internal PostHog dashboards (config only, no code) | n/a |
| PR 5b | Public aggregate dashboard at `orca.dev/analytics` (separate website repo; out of scope for this rollout) | n/a |

See `docs/telemetry-implementation.md` §Rollout — 5 PRs for the per-PR verification checklists and rollback notes.
