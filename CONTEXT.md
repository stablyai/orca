# Orca

Orca is an app that manages git worktrees and folder contexts and provides terminals and sessions for agent CLIs (Claude Code, Codex, Gemini CLI, opencode, and others).

## Language

**TuiAgent**:
One of the supported terminal-resident agent CLIs that Orca can detect, launch, and manage (e.g. `claude`, `codex`, `opencode`, `opencode2`). Each member of the `TuiAgent` union has a registry entry in `TUI_AGENT_CONFIG` describing how to detect and launch it.
_Avoid_: tool, agent CLI (when the identity matters), CLI provider

**opencode2**:
The official beta build of the opencode CLI, version 2, which installs and runs as the `opencode2` binary. It is a distinct TuiAgent from opencode (v1) — both binaries can be installed side-by-side, and Orca treats them as separate agents.
_Avoid_: opencode v2 (when the binary identity matters — they live in separate registries)

**opencode service (daemon)**:
The shared background server process that opencode2 uses to own sessions, plugins, and permissions. Multiple opencode2 invocations (TUIs, `run`, other tools) connect to it. Its state is registered in `~/.local/state/opencode/service.json`.
_Avoid_: opencode server (that is the v1 foreground server, which owns its session only while the TUI runs)

**Agent session ownership**:
Where a running agent conversation lives after the terminal that started it is gone. opencode v1 sessions are owned by the TUI's in-terminal server and die with the terminal; opencode2 sessions are owned by the opencode service and survive terminal close.
_Avoid_: session lifecycle (vague — ownership is the deciding property)

**Agent hook source**:
The origin of lifecycle status events Orca consumes to render agent status (working/done/waiting), conversation titles, and resume identity. opencode delivers hooks via an injected plugin posting to Orca's hook server; opencode2 delivers them via the opencode service event stream.
_Avoid_: webhook (a v1-only transport detail)
