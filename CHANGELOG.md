# Changelog

## Unreleased

### Added
- Multi-provider Claude accounts P4 — final rollout:
  - Headless CLI: `orca claude-accounts add|list|select|remove`
  - Provider coverage: anthropic-api-key, anthropic-compat (zai/kimi/minimax/custom),
    azure-foundry (api-key + Entra ID), aws-bedrock (token + IAM chain),
    google-vertex (ADC)
  - Encrypted-file secrets storage for Linux/Windows (libsodium crypto_secretbox + Argon2id);
    falls back automatically when the OS Keychain is unavailable.
  - `--validate` flag triggers a post-add probe before exit.
- Documentation: `docs/claude-accounts.md` covers CLI flags + storage backends.
- Multi-provider Claude accounts P3 (behind `claudeMultiProviderEnabled` flag):
  - AWS Bedrock provider with static-token and IAM-chain paths, region-derived inference-profile prefix
  - Google Vertex AI provider via Application Default Credentials (gcloud)
  - Remote preset registry (24h disk-cached) for live model-default updates with baked fallback
  - "Refresh defaults" UI control with relative-age timestamp
  - Live Detect probes for Bedrock (`aws sts`/`bedrock list-foundation-models`) and Vertex (`gcloud auth application-default print-access-token`)
- Multi-provider Claude accounts P2 (still behind `claudeMultiProviderEnabled` flag):
  - Azure AI Foundry provider with two authentication paths: API key (`ANTHROPIC_FOUNDRY_API_KEY`) and Entra ID (`az login` detection via the local Azure CLI). Uses the Foundry-specific env namespace (`CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`) — not generic `ANTHROPIC_BASE_URL`.
  - Workspace-scoped account override: each worktree can pick a default Claude account that beats the global default.
  - Per-worktree override editable from both the worktree "Update" dialog and the PTY tab right-click menu ("Use account for new terminals here…").
  - Validation probe ("Detect") for Foundry covers 401/403/network error states with locked rescue strings.

### Changed
- `claudeMultiProviderEnabled` now defaults to `true`. Set `ORCA_RELEASE_CHANNEL=disabled`
  to opt out of P4 features at startup.
- `prepareForClaudeLaunch` gains an optional `worktreeId` argument; PTY launches thread the worktree id so the workspace resolver can pick the override account.
- Persisted Settings gains a `claudeAccountIdByWorkspace: Record<string, string>` map (default `{}`).

### Security
- Secrets are read from environment variables named by `--key-env` / `--token-env`,
  never from argv/stdin. Encrypted-file passphrase lives only in main-process memory
  and is zeroed on quit.

### Performance
- In-process LRU keychain cache (size 50) eliminates the N+1 keychain read on PTY spawn (E2)
