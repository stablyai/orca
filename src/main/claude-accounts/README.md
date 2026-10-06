# Claude accounts

Owns Claude account registration, credential storage, and launch authentication.

- `service.ts`, `claude-account-registration.ts`, `claude-account-selection.ts`: account lifecycle.
- `runtime-auth-service.ts` and `runtime-auth/`: default-account synchronization and explicit profile preparation.
- `live-pty-gate.ts`: pending and live credential owners, durable PTY recovery, and refresh wakeup after the last owner releases.
- `isolated-account-auth.ts`: enrollment and canonical CLI credentials for profile-bound accounts.
- `account-credential-mutation.ts`: serializes enrollment, reauthentication, and usage polling for each account.
- `claude-managed-auth-storage.ts`, `claude-managed-auth-storage-types.ts`: storage operations and location/snapshot contracts.
- `managed-auth-path.ts`, `keychain.ts`: owned files through the host AppEnvironment port and platform credential storage.
- `profile-identity.ts`, `profile-launch-preflight.ts`: canonical identity and enabled settings authority checks for managed profiles.

Profile names and account bindings are defined in `../../shared/agent-launch-profile.ts`.
Usage polling in `../rate-limits/` shares the credential authority defined here.
