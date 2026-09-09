# TASK-BE-006: Update `docs/features/F32-team-rbac.md`'s role-model table

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-002 | **CR:** CR-RBAC-002
**Depends on:** TASK-BE-003 (the role model this doc describes must actually be true in code before the
doc claims it).

---

## Goal

F32's original role-model description (flat 3-tier `developer/lead/admin`) is out of date relative to the
architecture CR-RBAC-002 confirms and fixes: a global 2-tier role (`user`/`admin`, `auth-service`'s
`domain.Role`) plus a repo-scoped 3-tier role (`developer`/`lead`/`admin`, `RepoRole` in `repo.rego`).
"Lead" only exists at the repo scope, never as a global user role.

## What to do

Edit `docs/features/F32-team-rbac.md`'s role table/section to state plainly:

- Global role: 2 values only — `user`, `admin` (`auth-service`'s `domain.Role`). No global "lead".
- Repo-scoped role: 3 values — `developer`, `lead`, `admin` (`RepoRole`, enforced via
  `backend-go/policy/orca-authz/repo.rego`), assigned per-repo via `project-service`'s existing
  `update_repo_member_role.go`.
- A user's global role and their `RepoRole` on any given repo are independent axes — an `admin` global
  role additionally has the "global admin override" branch in `project.rego`/`repo.rego` (see
  TASK-BE-003), giving full access regardless of repo-level role/membership.

This is a documentation-only change; do not restate the whole CR here — one short section/table update is
enough.

## Acceptance Criteria

- [x] F32.md's role table shows the 2-tier global / 3-tier repo-scoped split, not a flat 3-tier model.
- [x] No mention of "lead" as a selectable *global* user role remains in the doc — the new callout says so
      explicitly ("2 values only, no global 'lead'"); the OLD flat table stays below it, clearly marked as
      history, matching this doc's existing convention for the "Project-scoped Server Visibility" section
      TASK-BE-013 already annotated the same way.
- [x] No production code touched — `.md` file only.

## gitnexus

Not applicable — documentation-only change, no symbol edited.

## Kết quả thực tế

Added a callout above F32.md's "### Roles" table (the section TASK-BE-013 did NOT touch — that task only
annotated "### Project-scoped Server Visibility" further down) stating the real 2-axis model: global role
(`user`/`admin`, `auth-service`'s `domain.Role`, enforced in `admin.rego`) is independent from repo-scoped
`RepoRole` (`developer`/`lead`/`admin`, enforced in `repo.rego`, granted via
`update_repo_member_role.go`), plus the global-admin override branch (`callerGlobalRole`, TASK-BE-003). The
old flat 3-tier table is kept immediately below, unedited, for history — same pattern the doc already uses
for its "Project-scoped Server Visibility" section. No code changed; no build/test impact.

## Blocking

Blocked on TASK-BE-003 (don't document a role model the code doesn't implement yet) — satisfied, TASK-BE-003
is DONE and `callerGlobalRole` reads `tenant.Role(ctx)` in the current working tree.
