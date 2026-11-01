# Project Hub for Orca (experimental v0.1)

This is a **native Orca plugin panel** for the personal fork `bcuyul/orca`. It does not replace Orca's Git, worktree, terminal, agent or orchestration engines.

## Features

- Multiple independently selected projects, with ten phases: discovery, research/stack, architecture, MVP, first validation, correction, final validation, smoke test, production, documentation.
- Stories, tasks, bugs, Jira JSON read-only import, status board and selectable task handoffs.
- Human-approved phase changes, blueprint, architecture diagram and Mermaid export.
- Select Claude Code, Codex or Hermes as implementer and a separate reviewer.
- An explicit terminal picker for the **focused Orca worktree**; inserts a handoff using `terminal.sendText` with `enter:false`, **never executes automatically**.
- Plugin-local storage and an exportable project JSON snapshot.

## Development

The panel follows the host bridge from `examples/plugins/hello-orca/` in upstream Orca 1.4.x. Install this directory as a development plugin in a separate Orca development profile and grant its declared capabilities. A normal browser can display `panel.html` as a non-persistent preview, but cannot exercise the real host bridge.

A project is **not** a worktree: deleting a task worktree must not delete project planning data. The current Orca plugin API does not expose stable repo/project identity or Run/Task creation through the panel. Choose the project manually. Do not mistake this prototype for full agent orchestration.

## Safety and limitations

- No direct Git changes, agent launches, automatic merges, shell commands or production deployments.
- Jira is imported manually from JSON only; no real-time sync.
- No credentials stored or requested.
- Treat imported ticket contents as **untrusted data**, not AI instructions.
- The panel needs real Orca-host integration and regression tests before production use.

## Planned integration

1. Native project/repository identity from Orca.
2. Authenticated Run/Task adapter using the existing Orca orchestration authority.
3. Review and CI evidence linked to selected work items.
4. Optional Jira connector with explicit sync and conflict resolution.
5. Workflow quality gates for all ten phases.
