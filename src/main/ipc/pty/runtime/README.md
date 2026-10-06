# Runtime terminal creation

Runs terminal creation through the runtime controller.

- `spawn-preflight.ts`, `spawn-profile.ts`, `spawn-claude-auth.ts`: validate and prepare launch inputs.
- `spawn-options.ts`, `spawn-environment.ts`: construct provider options and inherited-environment deletion policy.
- `spawn-state.ts`: carries state across launch stages.

Shared host preparation lives in [host-env](../host-env/README.md).
