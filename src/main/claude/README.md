# Claude sessions

Owns structured Claude process launches, transport and conversation recovery.

- `claude-structured-launch-resolution.ts`: resolves persisted sessions for acquisition.
- `claude-structured-session-acquisition.ts`: owns preparation release through publication or cleanup.
- `claude-child-process-environment.ts`: builds the CLI environment.
- `claude-stream-json-*`: process transport and lifecycle.

Account credential authority belongs to [Claude accounts](../claude-accounts/README.md).

Common profile snapshots and provider runtime resolution use [agent profiles](../agent-profiles/README.md).
