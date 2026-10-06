# Agent profile connections

Host service for previewing, registering and acquiring Claude/Codex launch bindings.

- `connection-contracts.ts`: host dependencies; public DTOs live in `../../shared/agent-profile-connection.ts`.
- `connection-service.ts`: guarded preview, serialized save/unlink, read-only snapshot resolution and acquisition.
- `snapshot-resolution.ts`: immutable home and identity checks against fresh provider observations.
- `launch-authority.ts`: sanitized provider identity observations and launch authority checks.
- `account-removal.ts`, `preparation-error.ts`: durable launcher deletion guards and safe provider refusal reasons.
- `provider-adapters.ts`: provider metadata and typed managed-account callback contracts.
- `runtime-composition.ts`, `managed-provider-bindings.ts`: settings-store composition and provider-owned account preparation.
- `terminal-command.ts`: direct argv pinning, explicit override refusal and after-shell environment binding.
- `host-discovery.ts`: detected CLI resolution and bounded conventional alias-file reading.
- `*.test.ts`: synthetic filesystem and provider ownership regressions.

Discovery uses [agent-profile-discovery](../agent-profile-discovery/README.md); persisted profiles
and immutable session bindings use `../../shared/agent-launch-profile.ts`. Inject host context
from the execution host, and a settings store that persists `agentLaunchProfiles`. Route every
profile mutation through one service instance to preserve write ordering. The typed
`ipc/agent-profiles.ts` handlers use this same instance; generic renderer settings updates cannot
write the profile catalog.

Managed callbacks must inspect the requested account's existing owned home without changing global
selection, then acquire provider-owned preparation with a release handle. Claude uses its runtime
auth service and pending credential-owner lease. Codex uses `prepareForCodexProfileLaunch` in
[its runtime home service](../codex-accounts/README.md), preserving current account selection and
shared auth provenance. Create one `createAgentProfileConnectionService` per execution host.

External preparation binds its configuration home and preserves custom-provider authentication.
Claude's canonical default home uses the host `HOME` and removes `CLAUDE_CONFIG_DIR` after shell
startup, preserving the CLI's default Keychain lookup. Other homes retain an explicit config-home pin.
External inspection defaults to unverified. An injected inspector must be read-only, return only
provider identity metadata, and use fixed provider status arguments through the shared process API
with a 5-second timeout and 64-KiB output bound. The common service neither reads tokens nor invokes
provider programs. Command connections require an explicit home assignment; bare CLI names and
absolute executable paths require folder selection because shell state can override the home.
Unverified identity permits fresh terminal acquisition only. A snapshot captured without verified
identity stays ineligible for resume or structured acquisition even if a later observation becomes
verified.

The launch caller applies `envToDelete` and `envPatch` at actual CLI execution **after shell startup**,
rejects conflicting explicit authentication overrides, and owns `release` until process creation or
cancellation. Preserve the returned snapshot in the session; prepare that snapshot for resume rather
than looking up the current launcher. Identity inspection is a preflight observation, so another
terminal can still change credentials after acquisition.

Terminal consumers pin with `pinAgentProfileTerminalCommand`, apply provider launch planning (such
as Codex process isolation), then call `bindAgentProfileTerminalEnvironment` with that host-generated
command. Keep `snapshot.agent` as `launchAgent` when executable basenames differ from provider names.
`prepareAgentProfileTerminalCommand` combines both phases for consumers without intermediate planning.

Argument restrictions follow the binding: managed OAuth commands reject provider/auth configuration
overrides, while external Codex commands retain provider/profile options. External Claude `--settings`
accepts inline JSON after checking that its `env` cannot change `CLAUDE_CONFIG_DIR`; mutable settings
paths and explicit settings-source changes require a separately validated launch path.

Structured create uses `resolveSnapshotById` without provider preparation; acquisition prepares the
captured snapshot. Provider, host, account, home and verified subject retain their original ownership.
The executable in a saved snapshot records the previous observation: each acquisition discovers the
same provider through host CLI discovery and pins its current canonical executable, allowing updates.
A previous command path is accepted only as a validated argv label and is replaced before execution.

Structured execution and pending acquisition ownership also guard account deletion after launcher
unlink. Durable closed history alone does not retain a credential home.

Managed Claude acquisition checks canonical CLI credentials and identity metadata against the account
before preparation, then checks enabled user/project/local and file-policy settings at the final cwd.
Competing authentication and observable unverified policy (MDM, cached remote policy, policy helpers)
refuse managed launch. These sources remain enabled for the CLI; external profiles retain their own
configuration. Provider startup can fetch or change policy after preflight, so the check is not an
atomic guarantee over a running session.
