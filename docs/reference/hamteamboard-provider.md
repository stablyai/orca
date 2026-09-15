# HamTeamBoard task provider

HamTeamBoard is a native Orca task provider. HamTeamBoard remains the source of truth
for planning and execution state; Orca supplies the workspace, terminal, and agent
experience around that state.

## Provider identity

A task source can identify a HamTeamBoard account or project with these optional,
nullable fields:

- `serverUrl`: the HamTeamBoard server selected by the user.
- `projectId`: the stable project identifier returned by HamTeamBoard.
- `projectKey`: a human-readable project key when the server exposes one.

The identity deliberately does not contain `TenantId`. Tenant scope must come from
the authenticated server context. Clients must not invent or forward a tenant value.
The source cache includes the server plus the stable project id (or project key as a
fallback), preventing two server/project selections from sharing cached results.

## Domain mapping

| HamTeamBoard      | Orca surface                                  |
| ----------------- | --------------------------------------------- |
| Project           | Task source and project selector              |
| Epic              | Group/filter and planning context             |
| Task              | Task row, detail, and workspace launch target |
| Checklist item    | Task detail and completion progress           |
| Dependency        | Blocked/ready state and prerequisite links    |
| Claim and lease   | Exclusive agent execution ownership           |
| Note and work log | Agent progress and execution history          |
| Row version       | Optimistic-concurrency guard on mutations     |

## Execution invariants

Before an agent mutates a task, the adapter must fetch fresh task state, claim and
start the task through HamTeamBoard, retain the returned lease and row version, and
renew the lease during long-running work. Completion must report the actual outcome
and use the latest row version. A conflict is surfaced for refresh and retry; it is
never hidden by overwriting newer board state.

Read-only browsing may operate without a lease. Creating or updating projects,
epics, tasks, checklists, dependencies, notes, work logs, or task status must go
through the HamTeamBoard adapter rather than local persistence.

## Delivery slices

1. Provider registration, identity validation, cache isolation, and settings state.
2. Authenticated MCP connection and project/task read models.
3. Task list/detail UI with epics, checklists, and dependencies.
4. Workspace launch with claim/start/renew/release lifecycle.
5. Mutations, work logs, completion, conflict recovery, and end-to-end tests.

Until slice 2 supplies a verified connection state, availability remains false and
HamTeamBoard cannot become an executable task source.
