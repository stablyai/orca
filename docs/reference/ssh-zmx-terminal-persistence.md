# SSH zmx terminal persistence

Orca's SSH relay is both a control-plane transport (git, filesystem, hooks,
watches) and, by default, the owner of remote terminal processes. Relay-owned
PTYs die with the relay: a Reset Relay, a relay crash, or a redeploy terminates
every terminal on that target.

The **zmx** backend is a per-target opt-in that moves PTY ownership out of the
relay into [zmx](https://github.com/neurosnap/zmx) sessions on the remote host.
The relay becomes a replaceable client of those sessions: quitting Orca, losing
the SSH connection, or resetting the relay leaves the shell and any foreground
agent (Claude, codex, …) running. Reopening Orca reattaches the same tab to the
same process — no agent `resume` command is sent.

## Enabling

Settings → SSH host → Advanced → "Use zmx for durable terminals". The setting
is persisted only when enabled (`SshTarget.terminalPersistenceBackend: 'zmx'`);
unset targets resolve to `'relay'` via `resolveSshTerminalPersistenceBackend`
(`src/shared/ssh-terminal-persistence.ts` — the single default).

Requirements and scope:

- The `zmx` binary must be on the remote login PATH (macOS/Linux hosts only).
  Deploy resolves it with a login shell; a missing binary fails the connect with
  an actionable message, not the relay-lost banner.
- The backend applies to terminals created **after** the next Reset Relay.
  Existing relay-owned terminals are not migrated.
- A running relay advertises its active backend; connecting with a different
  configured backend raises `RelayPtyBackendMismatchError`, which is classified
  as a terminal relay error ("Reset Relay to apply …") rather than retried
  through the relay-lost backoff.

## Lifecycle semantics

- Sessions live under `~/.orca-remote/zmx-pty/<sha256(socket)[:16]>/` on the
  remote host (`runtime/` for zmx state, `metadata/` for Orca's session
  records). The namespace derivation is shared between the relay and the reset
  script (`src/shared/zmx-pty-namespace.ts`) and must stay identical.
- Explicit termination is explicit: closing a tab or `Ctrl+D` at an idle shell
  kills the zmx session and removes its metadata. Quit, sleep, SSH loss, and
  relay replacement only detach.
- Reset Relay preserves zmx sessions (`preserveZmxSessions`) and skips the
  lease-expiry sweep when the stopped relay was zmx-backed. Resetting a target
  configured for `'relay'` keeps today's destructive semantics — including for
  hosts whose relay was launched zmx-backed by a build that defaulted to zmx:
  toggle the setting on before resetting to keep those sessions.
- SSH PTY leases (`sshRemotePtyLeases`) record tab/pane identity per session.
  `'detached'`/`'attached'` are restorable; `'expired'`/`'terminated'` clear
  every durable-terminal evidence (tab `ptyId`, layout leaf bindings, relay
  session mappings) so a dead session is never re-materialized as a tab.

## Restore pipeline

Terminal membership for direct-SSH worktrees is persisted in the target's
`ssh:` host partition (legacy `tabsByWorktree` format, written by the runtime
layer) while the renderer's visible tab strip hydrates from the unified tab
maps. `repairUnifiedTabMembershipFromLegacyTabs`
(`src/renderer/src/lib/unified-tab-membership-repair.ts`) re-materializes
PTY-bound tabs from legacy-only sources (host partitions at startup, remote
workspace snapshots on connect). PTY evidence is required so stale unbound tabs
are never resurrected — materializing them would spawn fresh shells and could
auto-resume sleeping-agent records the user already discarded.

The local partition's terminal-membership fence
(`rebaseWorkspaceSessionTerminalMembership`) does not apply to direct-SSH
worktrees: their membership authority is the `ssh:` partition, which carries
its own fence.
