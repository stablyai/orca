# Codex runtime state

Owns Codex home resources, short-lived app-server sessions and persisted terminal account routing.

- `codex-app-server-*`: shared RPC transport, capability observations and child lifecycle.
- `codex-pane-account-registry*`, `codex-profile-account-owners.ts`: durable pane ownership and pending profile leases.
- Home, configuration and state database modules support [managed accounts](../codex-accounts/README.md).

Profile launch authority composes these mechanisms through [agent profiles](../agent-profiles/README.md).
