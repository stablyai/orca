# Codex accounts

Owns managed Codex registration, credential-home ownership and runtime account routing.

- `service.ts`, `codex-account-registration.ts`, `codex-account-selection.ts`: account lifecycle; `add({ activate: false })` enrolls without changing selection.
- `runtime-home-service.ts` and `runtime-home-service-*.ts`: default-account synchronization, legacy migration and launch preparation.
- `independent-profile-home.ts`, `profile-config-authority.ts`: credential readiness, identity and configuration authority checks for the account-owned credentials used by independent profiles.
- `profile-launch-preflight.ts`, `profile-launch-authority.ts`: bounded provider configuration/account observation and same-home identity checks before managed launches.
- `host-codex-managed-home-ownership.ts`, `codex-managed-home-*.ts`: owned home validation and lifecycle.
- `codex-account-identity.ts`, `codex-auth-identity.ts`: provider identity interpretation.

`prepareForCodexProfileLaunch(accountId)` uses the read-only inactive-account ownership gate and
existing resource/config mirrors. It preserves selected account and shared auth provenance; the
CLI refreshes credentials in its own account home. Verified profile identity requires complete OAuth
credentials with a compatible active auth mode; stale OAuth metadata beside another credential mode
cannot establish the profile identity. Runtime consumers compose this through
[agent profiles](../agent-profiles/README.md). Resource and config mirroring live in `../codex/`.

Managed profiles accept the default/file CLI credential store and direct OpenAI OAuth configuration.
Conflicting provider, selected config profile, forced workspace, login method or credential-store settings are refused
before resource/config mirroring; external profile configuration remains user-owned.

Managed terminal launches inspect effective cwd configuration and policy using the existing app-server
session lifecycle, then compare the observed account and owned-home identity. The inspection uses
no turn/login/explicit refresh request; provider startup can still consult policy or update its owned
home. Unsupported authority is refused. Configuration and credential changes after observation
remain a time-of-check limitation. External profiles keep their user-owned provider configuration.

`profile-launch-authority.real-cli.test.ts` checks the app-server inspection protocol and logged-out refusal with a pinned container-local CLI. Opt in with `ORCA_PROFILE_PROTOCOL_SMOKE=1` and `ORCA_PROFILE_PROTOCOL_CLI`; the test requires a disposable Linux container and creates an empty home.
