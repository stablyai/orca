# Automations Control Plane

## Problem

Orca has a first-party Automations page, persisted schedules, and a local tick loop:

- `src/main/automations/service.ts:8` dispatches due Orca-owned automations through the renderer.
- `src/main/persistence.ts:1531` stores automations and run history.
- `src/renderer/src/components/automations/AutomationsPage.tsx:73` renders only Orca-owned automations.
- `src/main/ipc/automations.ts:11` and `src/preload/api-types.ts:1540` expose only native automation CRUD/run IPC.

That misses the user goal: Orca should manage both local automations and automations users already run in external agents. Hermes already has a real cron subsystem (`../../hermes-agent/cron/jobs.py`) and CLI/API operations (`../../hermes-agent/hermes_cli/cron.py`, `../../hermes-agent/hermes_cli/web_server.py`). Multica models remote execution as runtime-backed agents and autopilots (`/Users/jinjingliang/Documents/projects/multica/CLI_AND_DAEMON.md`). Paperclip separates routines from agent adapters, including HTTP/OpenClaw-style adapters (`/Users/jinjingliang/Documents/projects/paperclip/server/src/adapters/http/execute.ts`).

## Goal

Add an automation control-plane layer that can inventory and operate external schedulers without replacing Orca's native scheduler.

## Non-goals

- No Slack, Telegram, Discord, or other messaging integration.
- No cloud billing or hosted scheduler.
- No speculative scheduler protocols. Hermes and OpenClaw are managed through their concrete cron CLIs and storage formats.
- No destructive bulk changes to external jobs.

## Design

1. Add external automation manager types.
   Introduce `ExternalAutomationManager`, `ExternalAutomationJob`, and `ExternalAutomationAction` in `src/shared/automations-types.ts`. A manager has `provider`, target (`local` or `ssh`), status, optional error, and jobs. Jobs carry the stable external ID, name, schedule display, enabled state, next/last run timestamps, workdir, prompt preview, and last status.

2. Extend automation IPC/preload instead of overloading native scheduler types.
   Add `automations:listExternalManagers` and `automations:runExternalAction` handlers in `src/main/ipc/automations.ts`, mirrored in preload (`src/preload/index.ts` and `src/preload/api-types.ts`). Keep external state out of persisted native `Automation`/`AutomationRun` records and out of `AutomationService` tick logic.

3. Implement Hermes and OpenClaw cron as the first concrete external managers.
   Local inventory should use `~/.hermes/cron/jobs.json` and `~/.openclaw/cron/jobs.json` (read-only) so jobs can be listed even when the CLI is not currently runnable. Mutations must go through each owner CLI (`hermes cron pause|resume|run|remove <id>`, `openclaw cron disable|enable|run|rm <id>`) so each scheduler stays owner of validation/recompute rules. Never mutate jobs JSON directly.

4. Support remote Hermes and OpenClaw through existing SSH relay request/response mechanics.
   Add relay methods under `externalAutomations.*` (for example `externalAutomations.list` and `externalAutomations.act`) with a provider parameter. On remote, run command checks/actions via `/bin/sh -lc` for PATH parity with existing preflight behavior (`src/relay/preflight-handler.ts`). For JSON-RPC `-32601` method-not-found (old relay), map to manager status `unavailable` with an upgrade hint. Only call relay for currently connected targets with an active multiplexer; disconnected targets are synthesized locally as unavailable managers.

5. Surface external managers inside the Automations page as a separate section.
   Keep the existing local automation list/detail intact. Add an "External managers" dashboard section that shows each discovered manager, job counts, job rows, and per-job pause/resume/run/delete actions. Refresh pulls native automations, runs, and external managers together. Actions refresh the external inventory after completion.

6. Keep native dispatch unchanged.
   Native Orca automations still use `AutomationService`; external jobs are not copied into the native schedule table unless the user explicitly recreates them later. This avoids split-brain schedule ownership.

7. OpenClaw status.
   OpenClaw is a first-class `TuiAgent` and an external cron manager provider. The runtime support lets users launch OpenClaw in Orca; the external manager support inventories and operates OpenClaw jobs the user already owns.

## Edge Cases

- Hermes installed but no jobs file: show an available empty manager.
- Jobs file exists but `hermes` is not on `PATH`: show jobs, disable lifecycle actions with a clear manager error.
- Local jobs file unreadable/corrupt JSON: show manager unavailable with parse/read error; do not fail native automations refresh.
- Remote target disconnected or requires interactive auth: show an unavailable manager for that target, do not throw.
- Old remote relay lacks the external automation RPC (`-32601`): show unavailable with explicit "update remote relay" error.
- Remote Hermes jobs file missing: treat as available empty manager, not an error.
- Remote CLI missing but jobs file present: show read-only inventory and disable actions.
- OpenClaw gateway down: show inventory from its cron store when available; lifecycle actions surface the CLI failure and refresh state.
- Ambiguous Hermes job names are irrelevant because Orca always acts on IDs.
- Delete is per-job only and still uses Hermes CLI, not raw JSON mutation.
- In-flight action race (job deleted/changed externally between list and action): surface per-job action failure, then re-fetch manager state.
- SSH remains a first-class path; never assume local-only execution.

## Rollout

1. Add shared external-manager types.
2. Add Hermes/OpenClaw manager adapters in main and relay (`externalAutomations.*` methods).
3. Extend IPC/preload API (`listExternalManagers` + `runExternalAction`).
4. Add the external-manager dashboard section in Automations page.
5. Add unit tests for local Hermes mapping/actions, relay mapping/actions, and `-32601` fallback behavior.
6. Validate typecheck, lint, focused tests, and the Automations page in Electron.
