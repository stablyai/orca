# Project Default Agent

Status: Draft for product review

Date: 2026-10-27

Scope: Project settings, workspace creation, CLI launches, and Orca orchestration

## Goal

A user can choose a default coding agent for each Orca project. Creating a workspace in that project starts its agent without asking for the same choice every time. When an agent working in project A starts work in project B, Orca resolves B's default, not A's.

The same `default` selection rule must apply to desktop launches and CLI-driven handoffs or supervised workers.

## Terms

- **Target project**: the project that owns the workspace where the new agent will run. It is independent of the caller's current project and the parent workspace's project.
- **Project default**: a project setting with one of three states: `Inherit global`, a specific supported agent ID, or `Blank Terminal`.
- **Global default**: the existing `defaultTuiAgent` setting. A `null` global value keeps Orca's existing automatic agent-selection policy.
- **Explicit agent**: an agent ID selected for one launch, such as `codex`. It does not change either saved default.
- **Default request**: `--agent default` in the CLI, or the equivalent default choice in the desktop UI. Orca resolves it for the target project at launch time.

## Required behavior

### 1. Project setting

1. Project Settings exposes **Default agent** with `Inherit global`, `Blank Terminal`, and supported agent choices. A new or existing project initially uses `Inherit global`.
2. The value belongs to the Orca project, not to a repository path, project group, current workspace, or calling agent. It persists across app restarts and applies to all of the project's host setups.
3. The UI shows the saved value and, when inheriting, the effective global value. Saving provides clear success or error feedback. An unsuccessful save must not appear to have taken effect.
4. Changing the setting affects subsequent launches only. It does not replace or restart an already running agent.
5. `Blank Terminal` is an explicit project choice. It does not fall through to the global default.

### 2. Resolution rule

For a launch in target project B, resolve the requested agent in this order:

| Launch choice                          | Result                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| Explicit agent ID                      | Use that ID, subject to existing launch validation.        |
| `default` and B has a specific agent   | Use B's agent.                                             |
| `default` and B is `Blank Terminal`    | Do not start an agent. See the entry-point behavior below. |
| `default` and B is `Inherit global`    | Use the global default.                                    |
| `default` and no target project exists | Use the global default.                                    |

The source project A and any parent workspace affect lineage, not agent selection. A target project explicitly identified by the user or CLI must not be replaced by an inferred source project. If the target cannot be identified unambiguously, Orca reports that ambiguity before launching an agent.

A configured project agent that is unavailable or disabled on the execution host must not silently turn into A's agent, the global agent, or another installed agent. Report the unavailable choice and let the caller choose an explicit agent or update B's setting. Apply the same no-substitution rule when a specific global default is selected through `default`; retain existing automatic selection only when the global setting is unset.

### 3. Desktop workspace creation

1. Creating a workspace under B uses B's effective default without requiring a repeated agent selection. The UI may still offer an explicit per-workspace override.
2. An explicit per-workspace choice wins over B's default and does not change B's saved setting.
3. If B's effective choice is `Blank Terminal`, create the workspace without an agent.
4. The effective choice and any launch error are visible to the user. The UI must not claim an agent started until the launch result confirms it.
5. Apply the same project rule to git worktrees and folder workspaces wherever the existing product offers an agent-starting workspace flow.

### 4. CLI and orchestration

1. `orca worktree create --project B --agent default ...` resolves B's effective default on the execution host. A cross-project parent in A does not change this result.
2. `orca agent launch --worktree <B-workspace> --agent default ...` resolves the project that owns the selected workspace.
3. Supervised `orca orchestration worker-start --agent default` resolves the project of its selected existing workspace or target repository for a new workspace. `worker-start` currently targets a repository with `--repo`, not `--project`; its target project must be derived from the resolved repository/workspace, never from the coordinator's project.
4. Orca's bundled orchestration and CLI guidance uses `--agent default` when the user requests a new agent but does not name one. If a user in A explicitly requests Claude for work in B, orchestration passes `--agent claude` even when B has a different default. An explicitly named agent never changes B's saved setting. Guidance must not hard-code `codex`, `claude`, or the coordinator's agent for an unspecified target.
5. Omitting `--agent` from `worktree create` retains its existing meaning: create a workspace without launching an agent. Flags such as `--prompt` still require an agent choice. `worker-start` still requires `--agent` or `--terminal`.
6. `--agent default` that resolves to `Blank Terminal` is a clear pre-launch error for commands that explicitly require an agent. A plain workspace creation without `--agent` remains available.
7. Resolve once before creating a workspace or dispatch, then use that resolved agent through launch and recovery. A retry must not switch agents because a setting changed after the first attempt.
8. CLI and orchestration receipts identify the agent that actually started and whether the choice came from the target project, global setting, or automatic selection. Errors identify the target and the failed choice without claiming that a worker started.

### 5. Host and compatibility behavior

1. Agent availability is checked on the host where the target agent will run, including supported remote hosts. A client must not substitute its own installed-agent list or project setting for the execution host's authoritative result.
2. Older clients or servers that cannot persist or resolve a project default must reject that setting or `--agent default` operation with an actionable compatibility error before creating a workspace or worker. They must not silently ignore the project value or fall back to the global value.
3. This behavior applies on macOS, Linux, and Windows. It also applies to folder workspaces and paired or remote use where those launch paths are supported. Mobile clients must display the effective setting or a supported compatibility state; they must not write a value an older host will discard.

## Acceptance scenarios

| Scenario                                                                                 | Expected result                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Global default is Claude; B default is Codex; desktop creates a workspace in B           | Codex starts without another required agent choice.                                                           |
| Agent in A is Claude; B default is Codex; CLI creates B with `--agent default`           | Codex starts in B; A's agent and parent lineage do not change selection.                                      |
| Supervised coordinator in A starts a new worker in B's repository with `--agent default` | Worker uses B's default; the receipt names B and the resolved agent.                                          |
| B inherits global Claude                                                                 | A default request in B starts Claude.                                                                         |
| B is `Blank Terminal`                                                                    | Desktop creates a blank workspace; agent-required CLI commands fail before creation or dispatch.              |
| User in A explicitly requests Claude for work in B; B default is Codex                   | Orchestration passes `--agent claude`; Claude starts in B, and B remains configured for Codex.                |
| B default is Codex but Codex is unavailable on B's execution host                        | No different agent starts; the user gets an actionable error.                                                 |
| `worktree create --project B` omits `--agent`                                            | A workspace is created without an agent, preserving CLI behavior.                                             |
| B's setting changes while a launch is in progress                                        | The in-progress launch and its recovery use the initially resolved agent; later launches use the new setting. |
| Project B has a folder workspace or a supported remote host                              | Selection uses B's setting and the target host's availability, with no source-project fallback.               |

## Out of scope

- Repository-controlled `orca.yaml` defaults, project-group defaults, and organization policy.
- Per-project model, effort, prompt, or agent command arguments.
- Changing Source Control AI action-specific agent overrides.
- Automatically starting an agent for a CLI `worktree create` that omits `--agent`.
- Changing an already running agent when project settings change.

## Current baseline and implementation boundary

At the inspected checkout (`0cee6cbd86`), `Project` has no default-agent field; `defaultTuiAgent` is global. `worktree create` only launches an agent when `--agent` is supplied. The existing `worker-start` command requires `--agent` or `--terminal`. This spec defines the intended contract; it does not prescribe a particular persistence schema or RPC layout. An implementation must preserve mixed-version safety and the existing no-agent CLI path.

Related community requests: [#26911](https://github.com/stablyai/orca/issues/26911), [#22932](https://github.com/stablyai/orca/issues/22932), [#16913](https://github.com/stablyai/orca/issues/16913), and [#7257](https://github.com/stablyai/orca/issues/7257). [PR #31568](https://github.com/stablyai/orca/pull/31568) proposes global `--agent default` resolution; target-project resolution in this spec extends that meaning.
