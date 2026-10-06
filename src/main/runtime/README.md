# Host runtime

Composes execution-host services and persists structured conversation ownership.

- `orca-runtime-*`: runtime operations and service wiring.
- `agent-session-*`: durable records, lease transitions and operation admission.
- `structured-agent-session-runtime.ts`, `structured-agent-runtime-registrations.ts`: registered provider adapters, environment and lifecycle composition.
- `agent-profile-terminal-binding.test.ts`: shared snapshot builders through runtime copies and local transport guards.
- `structured-agent-profile.ts`: read-only profile capture and child environment policy.
- `structured-agent-session-create-adoption.ts`: committed intent replay and history ownership.
- `rpc/methods/`: host RPC handlers; see [method conventions](rpc/methods/README.md).

Provider account preparation belongs to [agent profiles](../agent-profiles/README.md), with process
acquisition owned by [Claude](../claude/README.md) and [Codex](../codex/README.md).
