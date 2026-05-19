# Changelog

## Unreleased

### Added
- Multi-provider Claude accounts P2 (still behind `claudeMultiProviderEnabled` flag):
  - Azure AI Foundry provider with two authentication paths: API key (`ANTHROPIC_FOUNDRY_API_KEY`) and Entra ID (`az login` detection via the local Azure CLI). Uses the Foundry-specific env namespace (`CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`) — not generic `ANTHROPIC_BASE_URL`.
  - Workspace-scoped account override: each worktree can pick a default Claude account that beats the global default.
  - Per-worktree override editable from both the worktree "Update" dialog and the PTY tab right-click menu ("Use account for new terminals here…").
  - Validation probe ("Detect") for Foundry covers 401/403/network error states with locked rescue strings.

### Changed
- `prepareForClaudeLaunch` gains an optional `worktreeId` argument; PTY launches thread the worktree id so the workspace resolver can pick the override account.
- Persisted Settings gains a `claudeAccountIdByWorkspace: Record<string, string>` map (default `{}`).
