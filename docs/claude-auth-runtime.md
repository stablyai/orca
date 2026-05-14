# Claude Runtime Auth Switching

Orca switches Claude Code accounts by materializing a selected managed account into Claude's shared runtime auth surfaces. The runtime surfaces are:

- `.claude/.credentials.json`
- macOS scoped Keychain credentials for the active `CLAUDE_CONFIG_DIR`
- macOS legacy `Claude Code-credentials`
- `.claude.json` `oauthAccount`

## Core Invariants

1. Never write a user/runtime surface unless Orca can prove it owns the current value on that surface.
2. Treat each credential surface independently. File, scoped Keychain, and legacy Keychain can each be owned, external, missing, or unknown.
3. `oauthAccount` metadata is restored or cleared only when metadata itself matches Orca's last managed value, or when a credential surface has already proved the current runtime state belongs to the managed account being cleaned up.
4. Invalid or unparsable runtime config is unknown, not null. Unknown config must be preserved.
5. Missing managed account records are unknown. Orca clears the active selection but does not mutate runtime auth without account identity proof.
6. Missing managed credentials for an existing account can be cleaned up using the account record identity. Only surfaces whose current credentials match that account are restored or cleared.
7. Read-back of refreshed tokens must evaluate all runtime credential candidates and persist only a single unambiguous managed-account match.

## Snapshot Policy

Before entering managed mode from system mode, Orca captures the system-default runtime state. On restore, the snapshot is only applied to surfaces whose current value still equals Orca's managed value, except for missing-managed-credential recovery where account identity is the proof.

Snapshots are schema-validated before use. Invalid snapshots are deleted and treated as absent.

When recapturing while the credentials file still equals the managed account, Orca preserves any previous snapshot value for Keychain surfaces that still equal the managed credentials. This prevents a failed restore followed by restart from recapturing managed Keychain values as system defaults.

## Read-Back Policy

Claude can refresh OAuth tokens in any runtime credential surface. Orca reads all available candidates, filters out stale or ambiguous matches, then chooses the freshest accepted candidate. Cold-start read-back is conservative: credentials must be newer than the matched managed account. Warm read-back rejects only metadata-proven older credentials, allowing equal-expiry token rotation.

## Failure Policy

Keychain reads during snapshot capture must succeed for both active services on macOS; otherwise Orca aborts managed entry. Best-effort Keychain reads are acceptable for token read-back because another surface may still contain a fresh candidate.

Add-account cleanup must restore/delete the legacy active Keychain item before reporting success. If cleanup fails, the login is treated as failed so Orca does not silently leave the user's legacy Claude state pointing at the captured account.
