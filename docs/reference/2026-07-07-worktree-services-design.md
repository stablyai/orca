# Per-Worktree Isolated Services

**Date:** 2026-07-07
**Status:** Approved design, pending implementation plan

## Problem

Worktrees share the developer's dev services (database, cache, queues). Tasks that mutate shared state — schema migrations being the canonical case — break every other worktree and agent session pointing at the same database. There is no first-class way to give a worktree its own isolated copy of the project's services.

Today a project can hack this via `scripts.setup` (`docker compose up`), but the setup script cannot: allocate collision-free ports/names across worktrees, inject connection env vars into the worktree's terminals and agents, or tear services down when the worktree is removed.

## Solution Overview

A new `services:` section in `orca.yaml` declares provider-agnostic service recipes (arbitrary `create`/`destroy` shell commands — Docker, Podman, local binaries, anything). At worktree creation, the user opts in to provisioning; Orca allocates a unique slot, runs the `create` commands, injects declared env vars into every terminal and agent in the worktree, and runs `destroy` automatically when the worktree is removed.

Orca has no notion of "database" — it executes lifecycle commands and injects env vars. Postgres, Redis, Mailhog, or a whole compose stack are all just recipes.

## `orca.yaml` Schema

New top-level key `services:`, following the `environmentRecipes` pattern:

```yaml
services:
  - id: db
    name: Postgres 16
    create: docker compose -f compose.dev.yaml -p "orca-$ORCA_WORKTREE_SLUG" up -d --wait
    destroy: docker compose -p "orca-$ORCA_WORKTREE_SLUG" down -v
    env:
      DATABASE_URL: postgres://app:app@localhost:${ORCA_PORT_0}/app
```

(The compose file maps the host port with the same variable, e.g. `"${ORCA_PORT_0}:5432"` — compose reads it from the environment Orca passes to `create`.)

- `id` (unique, same pattern/rule as recipe ids), `name`, `create`: required.
- `destroy`: optional; absence produces a doctor warning (guaranteed orphans otherwise).
- `env`: map of environment variables exported to the worktree. Values support substitution of the Orca-provided variables below, performed by Orca (plain string replacement, no shell).
- Orca provides these variables to `create`/`destroy` commands and to the exported env:
  - `ORCA_WORKTREE_SLUG` — unique name derived from the worktree.
  - `ORCA_SERVICE_SLOT` — small integer, unique among live provisioned worktrees, persisted.
  - `ORCA_PORT_0` … `ORCA_PORT_9` — ten pre-computed host ports, `20000 + slot × 10 + i`. Neither compose files nor Orca's substitution can do arithmetic, so Orca hands out ready-to-use port numbers; recipes never compute ports.
- Parsing lives in `src/shared/orca-yaml.ts`; `services` is added to `RECOGNIZED_ORCA_YAML_KEYS` in `src/main/hooks.ts`; malformed entries produce diagnostics like `environmentRecipeDiagnostics`.

## Creation Flow

- Worktree creation dialog: when the repo declares `services:`, show an opt-in checkbox "Provision isolated services" (default unchecked). All-or-nothing — no per-service selection.
- Order: git worktree created → slot allocated → each service's `create` runs sequentially, output streamed into the pending-creation card (same UX as ephemeral-VM provisioning) → `scripts.setup` runs with the service env vars injected, so setup can run migrations against the fresh database.
- `create` failure: error shown on the creation card; the worktree is kept without services (no git rollback). A "Retry provisioning" action is available on the worktree.
- `create`/`destroy` timeout: 10 minutes (image pulls), not the 2-minute `HOOK_TIMEOUT`.

## State & Lifecycle

- Main process persists per-worktree provisioning state: `{ slot, serviceIds, env }`, following the `ephemeral-vm-runtime-store.ts` pattern. Slot allocation picks the smallest free integer.
- Worktree removal/archive: run each provisioned service's `destroy`; failure produces a warning toast but never blocks removal. Slot is freed.
- Startup orphan cleanup (pattern: `ephemeral-vm-runtime-cleanup.ts`): compare the store against existing worktrees; re-run `destroy` for entries whose worktree is gone (e.g. crash mid-removal), then free their slots.

## Env Injection & Runtime

- Resolved `env:` values plus `ORCA_WORKTREE_SLUG`/`ORCA_SERVICE_SLOT`/`ORCA_PORT_*` are injected into every PTY (terminals and agents) created for the worktree, sourced from the persisted state. Nothing is written into the worktree.
- `scripts.setup` and `scripts.archive` receive the same variables, in addition to the existing `ORCA_*` path variables.
- SSH/WSL: `create`/`destroy` execute where the worktree lives, through the same project-runtime routing as existing hooks (`runHook`). Services run on the worktree's host, not on the machine running Orca.

## UI

- Worktree card: badge/indicator for service state (provisioned / error) with a "Retry provisioning" action.
- No manual start/stop controls (deliberately out of scope; destroy-on-removal only).
- Repo settings: doctor diagnostics surface recipe problems (pattern: `ephemeral-vm-recipe-doctor.ts`) — missing `destroy` → warning; duplicate/invalid `id` → error.

## Error Handling Summary

| Failure | Behavior |
| --- | --- |
| `create` fails | Error on creation card; worktree kept; retry action |
| `destroy` fails on removal | Warning toast; removal proceeds; slot freed |
| Orphaned state (crash) | Startup cleanup re-runs `destroy`, frees slot |
| Malformed recipe | Doctor diagnostic in repo settings |

## Testing

Unit tests only — no Docker-dependent e2e:

- `orca-yaml.ts` parsing: schema validation, diagnostics, `${...}` env substitution.
- Slot allocation/release: smallest-free-integer, persistence, concurrent worktrees.
- Lifecycle sequencing: create → setup → destroy ordering; failure paths (create fails, destroy fails).
- Orphan cleanup: store entries without matching worktrees.

## Out of Scope

- Per-service opt-in at creation (all-or-nothing).
- Manual start/stop of provisioned services.
- Provisioning services on an existing worktree after creation (beyond retry-after-failure).
- Dynamic port probing (ports are deterministic from the slot via `ORCA_PORT_*`; Orca does not check whether a port is actually free).
- Data seeding/cloning (a recipe's `create` command owns that).
