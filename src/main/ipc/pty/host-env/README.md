# Host terminal environment

Resolves host-owned configuration before terminal creation.

- `agent-profile-launch.ts`, `agent-profile-ownership.ts`: host snapshot acquisition and process ownership transfer for common profiles.
  External Claude homes that canonically match the runtime auth directory share its pending/live refresh gate; independent homes stay outside that gate.
- `claude-launch-auth.ts`: Claude credential admission and pending ownership.
- `codex-home.ts`: Codex home selection.
- `types.ts`: preparation dependencies shared by desktop and runtime spawns.

Credential storage belongs to [Claude accounts](../../../claude-accounts/README.md).
