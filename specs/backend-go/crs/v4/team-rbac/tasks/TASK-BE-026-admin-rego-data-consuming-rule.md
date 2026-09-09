# TASK-BE-026: `admin.rego` — one additive rule proving published policy data has real effect

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/policy/orca-authz/admin.rego`, `backend-go/policy/orca-authz/admin_test.rego`
>
> **Kết quả thực tế:** Confirmed via direct read (not `codegraph_explore`, per this task's own note that
> Rego isn't part of the Go symbol graph) that `admin.rego`'s shape still matched the sketch exactly —
> one `allow` rule, no `data.*` reference anywhere in the 5 rule files. Added the single additive clause
> verbatim as specified. Added 3 new `admin_test.rego` cases (absent-data unchanged-behavior, present-data
> listed-actor additionally-allowed, present-data unlisted-actor still-denied) alongside the 3 pre-existing
> ones. Ran `opa test backend-go/policy/orca-authz -v`: **38/38 PASS** (all 5 rule files' existing suites +
> the 3 new admin cases), confirming both the additive-only contract and no regression elsewhere. No other
> `.rego` file touched.

**Solution:** BE-SOL-006 | **CR:** CR-RBAC-006
**Depends on:** none — independent of TASK-BE-024/025/027 (pure `.rego` change + `opa test`), but
functionally meaningless until TASK-BE-024/025/027 all land (nothing publishes to the path this rule
reads until then).

---

## Goal

**Important finding this rule exists to fix**: none of the 5 rule files in
`backend-go/policy/orca-authz/` (`admin.rego`, `project.rego`, `repo.rego`, `annotation.rego`,
`task_grant.rego`) reference any `data.*` document at all today — every rule's `input` is entirely
caller-supplied. This means even a perfect publisher writing a perfectly-formed `data.json` changes
nothing today, because no rule consults it. This task adds the smallest possible consuming rule to prove
the publish-to-effect pipeline is real for one representative case.

**Explicitly scope-limited**: this does not attempt to cover F32's full resource×action matrix — wiring
every action across every service's Rego file to consult admin-authored policy data is a separate, larger
effort, out of scope here.

## What to do

Extend `backend-go/policy/orca-authz/admin.rego`'s existing `allow` rule with one additional, purely
additive clause:

```rego
package orca.authz.admin

import rego.v1

default allow := false

allow if {
	input.actor.role == "admin"
}

# Additive override consuming an AccessPolicy of kind "admin_override",
# name "extra_admins" — published by PolicyDataPublisher to
# data/admin_override/extra_admins.json. Absent by default (data.orca...
# undefined), so this clause is a no-op until an admin explicitly creates
# that policy — never changes behavior for a deployment that never uses it.
allow if {
	input.actor.id in data.orca.authz.admin_override.extra_admins.user_ids
}
```

Add `backend-go/policy/orca-authz/admin_test.rego` cases for both branches: `data.orca...` absent → old
behavior unchanged; `data.orca...` present with the actor's id → additionally allowed.

## Acceptance Criteria

- [x] `admin.rego`'s new clause is purely additive — no existing `allow` case changes its outcome.
- [x] `opa test` passes: policy-absent case behaves identically to before this change; policy-present case
      allows the additional actor id.
- [x] No other `.rego` file touched — this is deliberately a single proof-of-concept clause, not full
      resource×action coverage.
- [x] Code comment on the new clause explains it is additive/no-op-by-default, matching the text above.

## gitnexus

Not applicable, as anticipated — `codegraph_explore("admin.rego admin_test.rego")` returned only unrelated
TypeScript/frontend "AdminPolicy" symbols, confirming Rego files aren't part of the Go symbol graph.
Confirmed the file's current shape via a direct `Read` instead (per this note's own fallback) — matched
the sketch exactly, no drift since BE-SOL-006's pass. `impact()`/`detect_changes()` don't surface `.rego`
changes at all (confirmed: `detect_changes({scope:"compare", base_ref:"main"})` run jointly for all 7
Wave-1 tasks shows no `admin.rego`/`admin_test.rego` entries in `changed_symbols`) — `opa test` is this
task's only real verification signal, see "Kết quả thực tế" above.

## Blocking

None structurally. Land alongside or after TASK-BE-025/027 so there's an actual publisher able to write
`data/admin_override/extra_admins.json` for the "policy present" test case to exercise meaningfully in an
integration test (unit-level `opa test` cases work regardless).
