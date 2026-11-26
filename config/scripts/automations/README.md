# Automation Full Access policy

The host setting `automationFullAccess` is opt-in and applies to existing and future
automations on that host. It does not change manual-chat defaults or bot settings.
Schedules, prompts, business authorization and saved automation definitions stay intact.
Enable it separately on each remote host that owns automations.

`fullAccessBotIds` additionally scopes the policy to chats started for selected bots
and local descendant workers. Pass comma-separated bot UUIDs as the third script
argument; omitting it preserves the list and `none` clears it. This is
independent of the automation switch. Handoffs from those bot/worker chats inherit
Full Access. Reused structured workers receive the permission before delivery;
existing PTY reuse refuses: omit `--terminal` to start fresh. Closed-worker follow-ups
create a fresh worker with prior-work context instead of reopening
a possibly restricted process. Federated worker starts for selected bots refuse
before forwarding until the remote protocol can carry this policy.

From this checkout, with a corrected host running:

```sh
pnpm exec tsx config/scripts/automations/set-automation-access.ts inspect
pnpm exec tsx config/scripts/automations/set-automation-access.ts enable /absolute/new-backup.json
```

The script refuses unsupported hosts before writing, exclusively creates a policy
backup, uses a durable compare-and-set RPC and reads the result back. A concurrent
change refuses the operation; inspect again instead of retrying blindly.

New chats receive Full Access at creation. Reused chats receive a persisted option
change before delivery. This also affects subsequent manual turns in those specific
shared chats. Disabling the policy does **not** restore their previous permission
choices. Before enabling, record permission choices for every existing shared target
chat using `agentSession.options`, and retain those records with the policy backup.
If that continuing access is unwanted, use dedicated automation chats instead.
Reused terminals start fresh under this policy, without rewriting the reuse preference.
Unsupported agents fail rather than silently choosing a weaker permission mode.

## Deployment and rollback

Build the normal Windows release assets with `pnpm run build:release`, then
`pnpm run ensure:electron-runtime` and `pnpm exec electron-builder --config
config/electron-builder.config.cjs --win --publish never`. Set
`ORCA_BACKGROUND_LAUNCH=1` throughout; set `ORCA_LOCAL_BUILD_VERSION` to a distinct
prerelease version. A local unsigned installer is not an official signed release.
Record its source commit and SHA-256, and retain the previous signed installer.
Installing/restarting requires a coordinated maintenance window; building does not.

To undo activation, use `set-automation-access.ts disable` with a new backup path.
Do not downgrade until no affected run is active. Restore shared-chat choices from
the preactivation records through the supported session option API, checking its
current runtime fence and choice first. Do not overwrite an intervening user choice.
Only then install the previous binary during the maintenance window. A binary
rollback alone does not revert saved chat permissions. No database or ASAR edits
are part of this procedure.

## Harmless runtime probe (after deployment only)

`prepare-automation-access-probe.ps1 -Bot <test-bot> -Output <new-json>` only writes
a reviewable local plan. It neither creates nor runs an automation. Execute the
listed CLI arguments after activation in a dedicated test chat, without business
operations; retain the new automation, run, chat and Codex thread IDs. A bot caller
can redirect a new run into its own chat, so check the returned chat ID is new.
Do not accept a previously existing chat as proof of fresh launch.

Audit the resulting Codex transcript, explicitly naming that new thread:

```powershell
./config/scripts/automations/audit-automation-access.ps1 -Transcript <jsonl> -ExpectedThread <new-thread-id> -RequireFullAccess
```

The audit requires actual `thread_settings_applied` events with approval `never`
and unrestricted filesystem/network (or disabled permission sandbox). A final
database permission label is insufficient. Repeat on the dedicated shared test
chat and after a coordinated host restart to verify reuse and persistence. Delete
only the disabled probe automation afterward; do not close user sessions.

For selected bots, repeat fresh-session evidence for an ordinary new chat, a
continuation, recovered failed chat, agent handoff, worker and worker follow-up.
Use only the marker, with no tools or business actions. For Claude, verify provider
initialization reports `bypassPermissions`; terminal launch uses
`--dangerously-skip-permissions`. A user default of `auto` proves neither. Preserve
project/managed deny rules: Claude documents that deny rules apply even in bypass
mode, and managed settings can prohibit bypass. Record these constraints separately.
See https://code.claude.com/docs/en/permission-modes and
https://code.claude.com/docs/en/permissions.

`audit-claude-access.ps1 -WireTranscript <jsonl> -ExpectedSession <new-session-id>`
validates captured provider `system/init` and `system/status` frames. It refuses
missing initialization, mixed sessions or any reported mode other than bypass.
Do not substitute a settings file or final saved permission label for wire frames.
