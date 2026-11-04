# Workflow Builder

Design, save, and run multi-agent workflows on a canvas. Each agent node becomes a real Orca worker (a Task and a Dispatch in an Orca Run), started in your workspace when its dependencies settle. A deterministic controller in the main process decides **when** each step may run and **what** each agent may receive; the agents decide **how** to do their work.

Open it from **Workflows** in the left sidebar.

## How it differs from Orca orchestration

Orca's orchestration layer (`orca orchestration …`, see [the orchestration docs](site/content/docs/cli/orchestration.mdx)) gives you the building blocks: Runs, Tasks, Dispatches, workers, mail and decision gates. A coordinator, usually an agent, decides what to start, when to start it and what to tell each worker. The Workflow Builder keeps those building blocks and moves the decisions into Orca:

- **Scheduling is deterministic.** A pure scheduler in the main process starts nodes when their dependencies settle, and handles parallel branches, joins, decisions, approvals, retries and bounded loops. No agent decides the order.
- **Routing is enforced.** Messages between workflow agents pass a route guard inside `orchestration.send`. A message with no drawn route, or one that breaks the route's policy, is refused before anything is written.
- **Payloads are selected.** Each route picks what travels from the sender's final report, within size, count and rate budgets. The conversation itself never travels.
- **Order and data are separate.** Execution dependencies and communication routes are two different graphs.
- **Runs are reusable and recoverable.** Presets hold the whole design. Each run executes a frozen copy, is saved to disk, and resumes after a restart from Orca's own Task and Dispatch rows.

Nothing new runs outside the orchestration runtime: every step is an ordinary Orca Task and Dispatch, so `orca orchestration task-list`, `worker-show` and `worker-read` work on workflow runs too.

## Using it

### Design mode

- **Node library** (left): drag a node onto the canvas, or click it to drop one at the centre.
  - **Agent / Coordinator / Reviewer** run a CLI agent for one task.
  - **Start** settles when the run begins. **End** finishes the run and collects every completed agent's report into the run output.
  - **Parallel** starts its branches together. **Join** waits for every incoming branch (or the first, in `any` mode). Branches a decision skipped count as settled, so they never block a join.
  - **Decision** takes the first outgoing branch whose condition matches, in order; an unconditioned branch is the fallback.
  - **Approval** waits for you to approve or reject in Execution mode, backed by an Orca decision gate.
- **Ports** are typed. Top and bottom ports are **execution dependencies** (order). Side ports are **communication routes** (who may send what to whom). A route never implies an order, and a dependency never carries data.
- **Inspector** (right) edits whatever is selected: an agent's identity, runtime and model, instructions, skills, and tools; a dependency's condition and loop bound; a route's policy; or, with nothing selected, workflow-wide settings and budgets.
- **Toolbar**: preset menu (new, templates, saved presets, save as copy, import, export, delete), save, undo/redo, auto-layout, fit view, edge layer filter, validate, and Run.
- **Shortcuts**: ⌘/Ctrl+S save, ⌘/Ctrl+Z undo, ⌘⇧Z or Ctrl+Y redo, ⌘/Ctrl+C/V copy and paste, ⌘/Ctrl+D duplicate, ⌘/Ctrl+A select all, Delete or Backspace remove, Esc clear selection. Right-click a node, edge, or empty canvas for the same actions.

### Agents, models, and skills

- **CLI agent**: any Orca-supported TUI agent. Agents not detected on this computer are labelled; the execution host checks again at launch and refuses a run whose agent is missing there.
- **Model and effort** come from Orca's own launch catalog, and validation uses the same check `orchestration worker-start` applies (`checkAgentLaunchModelPreferences`). An agent that cannot take a model at launch offers only "Agent default". A refused model fails validation unless **Allow model fallback** is on; each attempt records the requested and the effective model.
- **Workspace isolation**: _shared workspace_ (the run's workspace), _isolated child worktree_, or _isolated top-level worktree_. Isolation needs a Git repository.
- **Instructions**: role instructions, a task template with `{{objective}}`, `{{node.label}}`, `{{iteration}}`, `{{run.id}}`, read-only context, output requirements, and an optional JSON result contract. **Preview** shows the exact prompt sections the workflow will send, labelled by source.
- **Skills**: attach installed skills (discovered through Orca's skill discovery). Orca verifies they are installed on the execution host and names them in the prompt. Required skills block launch when missing.

### Routes and payloads

A route grants one direction of communication between two agents. Its policy decides:

- which message types it carries;
- the payload: task specification (the recipient's own `tasks.<id>` entry), structured JSON, summary, selected fields, git change reference, artifact references, test results, fixed context, or the full worker report (needs an explicit switch);
- size, per-run count, and rate limits, plus what happens when a limit is hit (reject, truncate text, ask for a shorter message, hold for review, or fail the task);
- whether every message needs your approval, and whether refused payloads are logged.

The sender's conversation is never forwarded; only what the policy selects from its final report travels.

### Running

**Run** asks for an objective and a workspace. Orca opens a background coordinator terminal titled _Workflow · name_ in that workspace, creates an Orca Run, and from then on the controller starts each agent as a worker when its turn comes. The run executes a frozen copy of the workflow; editing the preset afterwards does not change it.

In **Execution** mode the same graph shows live state from Orca: each node's status, attempt, revision, model, and elapsed time; routes show message counts and pulse when a delivery is recorded. Selecting a node shows its Orca Task and Dispatch ids, requested versus effective model, the report, the prompt that was sent, earlier revisions, a **terminal** link, and Retry or Approve/Reject when they apply.

Run controls:

- **Pause** stops new tasks from starting. Workers already running continue until they report; pause does not claim to pause them.
- **Resume** restarts scheduling.
- **Cancel** stops each running worker with Orca's guarded `workerStop`. Workers Orca cannot prove stopped stay marked _Unconfirmed_.
- **Retry** on a failed, cancelled, or unconfirmed task starts a new attempt (a new Dispatch, linked to the previous one) and re-arms anything its failure skipped.
- **Stop and retry** on a running task first stops its worker with Orca's guarded stop, then starts a new attempt only if the stop is proven. Use it when a worker ended its turn on an error without reporting (Orca raises an escalation; the Dispatch stays open until a timeout, a stop, or a report).
- **Run again** starts a fresh run from the current preset.

The bottom panel has the timeline, a searchable and filterable message log (payloads, refusal reasons, release or drop of held messages, replies to worker questions), metrics, run output, errors, validation issues, and run history. Messages and metrics export as CSV or JSON.

## Testing

- Unit and integration tests: `pnpm test src/shared/workflow src/main/workflows src/renderer/src/components/workflows`. The controller tests drive real Orca Runs, Tasks, Dispatches, routing and stale-report rejection through the in-process RPC dispatcher; only PTY spawning is replaced.
- Screenshots: `pnpm fixtures:shot 'workflows/WorkflowsPage' --theme both`.
- Live run with real Claude Code workers (opt-in, uses your Claude usage): build with `pnpm exec electron-vite build --mode e2e` and `pnpm run build:cli`, export `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, then run `ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 ORCA_E2E_LIVE_AGENTS=1 npx playwright test --config tests/playwright.config.ts --project=electron-headless tests/e2e/workflow-builder-live.spec.ts`. The E2E fixture runs Orca hidden with a disposable profile and HOME, so your normal Claude login is not visible to it; credentials must come from the environment.

## Default templates

| Template                    | Shape                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sequential Development      | Planner → Implementer → Reviewer, rejected reviews loop back to the Implementer (up to 2 revisions)                                                                                                     |
| Parallel Development        | Coordinator → Backend ∥ Frontend (isolated worktrees) → Join → Reviewer → Integration                                                                                                                   |
| Research and Implementation | Researcher → Architect → Implementer → Validator                                                                                                                                                        |
| Hierarchical Team           | Coordinator plans → three specialists in parallel → Coordinator synthesises → Reviewer                                                                                                                  |
| Minimal Communication       | Three independent workers → 2 KB truncated summaries → Aggregator                                                                                                                                       |
| Authentication Feature      | Coordinator (Claude) → Backend (Codex) ∥ Frontend (Claude) → Reviewer (Codex) → approved: End, rejected: back to the Coordinator (up to 2 revisions). Backend and Frontend have no route to each other. |

Templates are read-only; saving one makes a copy.

## Architecture

```
renderer (Workflow Builder)                main process (per runtime)
  editor store (draft, undo, selection)      workflow.* RPC methods
  React Flow canvas (presentation only) ──▶  WorkflowController ─▶ WorkflowRunSession (one per run, serial)
  run view store (polls workflow.runGet)       │  deterministic scheduler (shared, pure)
                                               │  edge delivery + policy validator (shared, pure)
                                               ▼
                                             WorkflowOrcaAdapter ─▶ in-process RpcDispatcher
                                               terminal.create, orchestration.runCreate / taskCreate /
                                               workerStart / check / send / gateCreate / workerStop
                                               reads Task + Dispatch rows from the orchestration DB
```

- **Canonical schema** (`src/shared/workflow/workflow-definition-schema.ts`, `workflow-communication-schema.ts`, `workflow-condition-schema.ts`): Zod-validated, versioned (`schemaVersion: 1`), with migrations in `workflow-preset-migration.ts`. The React Flow layout is a separate `layout` field that never reaches the controller.
- **Two graphs**: `dependencies` (execution order; validated acyclic except explicit bounded `loop` edges) and `communication` (routes; cycles allowed).
- **Scheduler** (`workflow-scheduler.ts`, `workflow-branch-resolution.ts`, `workflow-task-settlement.ts`): a pure state machine over the run record. Each node has one task per loop iteration (`nodeId#iteration`), and each task has one dispatch record per attempt. Reports for a superseded iteration or attempt are ignored as stale.
- **Controller** (`src/main/workflows/`): `workflow-run-session.ts` serialises state changes per run and keeps Orca calls between turns; `workflow-task-dispatch.ts` assembles the prompt and starts the worker; `workflow-run-reconciliation.ts` settles tasks from Orca's own Task and Dispatch rows (authoritative), handles worker exits and timeouts; `workflow-mail-pump.ts` holds Orca's unfiltered `check --wait` on the Run mailbox for prompt wakes and records questions and escalations; `workflow-run-lifecycle.ts` covers launch, restart recovery, approvals, cancel, and finalize.
- **Orca integration** (`workflow-orca-adapter.ts`): every effect goes through the same RPC handlers the `orca` CLI reaches, dispatched in process with deterministic `orchestrationRequestId`s, so a replayed mutation after a crash returns its first receipt instead of acting twice.
- **Routing enforcement** (`src/main/runtime/orchestration/workflow-route-guard.ts`): `orchestration.send` calls the guard for every point-to-point and group message after recipient resolution and before any row is written. The controller registers a guard per Orca Run it owns; it applies `authorizeWorkflowMessage` (`workflow-communication-policy.ts`), the same validator the controller uses for payloads it carries itself. Refusals return `workflow_route_refused` with the policy rule in `data.policyCode` and `effectsApplied: false`.
- **Persistence** (`workflow-store.ts`): presets in `userData/workflows/presets.json`, one file per run in `userData/workflows/runs/`, all written atomically with owner-only permissions and re-validated on load. Runs resume on startup (`startWorkflowControllerRecovery`).
- **Remote hosts**: runs execute on the runtime that owns the chosen workspace; the renderer sends the preset inline so a remote host runs exactly what was designed.

## Security boundary and limitations

- Orca enforces **message routing between workflow agents that use Orca orchestration**, workspace placement, timeouts, attempt limits, and communication budgets. It does not sandbox agents: an agent with shell access can still read files, run commands, or use the network outside Orca. Tool settings and forbidden actions are instructions to the agent, not restrictions. Use OS-level sandboxing or the agent CLI's own permission settings when you need hard limits.
- Messages from senders that are not workflow agents (for example your own terminal) are outside the workflow's authority and pass through.
- A worker's own send cannot be rewritten or parked inside Orca, so _truncate_ and _hold_ refuse it with guidance; the controller truncates or holds only the payloads it carries between tasks.
- Agents load skills from their own skill directories, so Orca cannot hide other installed skills from an agent.
- Token counts are **estimates** (4 bytes per token) over routed payloads. Orca does not receive per-worker provider usage for terminal agents, so model usage is shown as unavailable.
- The coordinator terminal is a plain shell kept as the Run's coordinator identity. The controller keeps an unfiltered mailbox waiter on it so Orca does not type mail pointers into it; even if one were typed, task outcomes are read from Orca's Task rows, not from mail.
- If Orca restarts with a different runtime identity, a worker start that was in flight may not be recognised as a replay; the controller then reconciles from Orca's records and marks anything it cannot prove as _Unconfirmed_.
- **Maximum run duration** is recorded as a warning when exceeded; it does not stop workers.
