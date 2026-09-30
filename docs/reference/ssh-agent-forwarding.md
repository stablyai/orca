# SSH Agent Forwarding

How Orca forwards your local SSH agent to an SSH host, why a remote shell keeps a working `SSH_AUTH_SOCK` across reconnects, and how to tell which layer broke when `ssh-add -l` fails remotely.

## The rule

**A remote process sees the agent that a fresh `ssh <host>` on the current connection would see** — no more, no less. Three consequences:

1. **Forwarding follows OpenSSH semantics, not the login path.** `ForwardAgent yes|no|<path>|$VAR`, `IdentityAgent` (including `none`) and the per-host override decide it. How authentication ended — agent, disk key, passphrase, password, keyboard-interactive — never does, and `IdentitiesOnly` narrows only what is _offered to the server_.
2. **The agent follows the live connection.** Shells, relay git and agent exec keep working after a reconnect without re-exporting anything. This is deliberate authority, the same as tmux's `~/.ssh/ssh_auth_sock` symlink: any process the relay started for this remote account — including a shell from before the reconnect — can use the agent of the connection that is live now, and none while it is not. Hosts where earlier processes must not inherit that authority should not enable forwarding.
3. **No borrowing.** If the current connection forwards nothing, remote processes have no agent — never an older connection's.

## Mechanism

| Layer                  | Where                                                                                                | What it does                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent                 | `src/main/ssh/ssh-agent-forwarding-intent.ts`                                                        | One resolver for both transports. Precedence mirrors `IdentityAgent`: fresh `ssh -G` wins for config-backed targets (the stored value is an import-time fallback); an explicit per-host choice wins for manual targets.                                 |
| ssh2 login vs. forward | `src/main/ssh/ssh-connection-utils.ts`, `ssh-private-key-authentication.ts`                          | `config.agent` carries **only** the forwarded agent. The login agent lives in a WeakMap read by the auth queue, so the agent-fallback retry drops it without dropping forwarding.                                                                       |
| ssh2 request           | `src/main/ssh/ssh-agent-forwarding-request.ts`                                                       | Forwarding is requested per exec, not via ssh2's connection-level `agentForward`: ssh2 asks with want-reply and fails the channel on refusal. A refusal retries that exec without forwarding once; later execs stop asking (OpenSSH's behavior).        |
| System OpenSSH         | `src/main/ssh/system-ssh-args.ts`                                                                    | Config-backed hosts: OpenSSH reads `ssh_config` itself. Manual hosts with an explicit choice: `-o ForwardAgent=yes\|no`. The choice is part of the ControlMaster key, because a master's forwarding is fixed when it spawns.                            |
| Relay binding          | `src/relay/relay-agent-socket-binding.ts`, `relay-connect-channel.ts`, `relay-reconnect-listener.ts` | Each `--connect` bridge reports its own `SSH_AUTH_SOCK` in the handshake. The detached daemon points one symlink (`agent-<hash>.sock`, beside the relay socket) at the PTY session owner's socket, else the newest bridge's, and exports the link path. |

Why the relay needs the binding: the daemon is launched once (`nohup … --detached`) and outlives the connection that launched it. Its inherited `SSH_AUTH_SOCK` dies with that connection — immediately under system ssh without ControlMaster — and a running shell's environment cannot be changed afterwards. Moving a symlink's target is the only way to repair shells that already exist.

Invariants to keep:

- **Only `clientRole: 'connect-bridge'` peers speak for a connection.** `--orca-cli` clients share the handshake but run inside relay PTYs; their `SSH_AUTH_SOCK` is the link itself.
- **Register before dispatch.** The bridge is registered in `onClientAccepted`, before its leftover bytes reach the dispatcher, so its first `pty.spawn` sees the binding.
- **Unbound means unset.** With no bound socket the link is removed and `SSH_AUTH_SOCK` is deleted from the daemon's env — what plain `ssh` does without forwarding. Always exporting the link would break rc files that start an agent when the variable is empty.
- **Spawn sites read `process.env` at spawn time.** PTY (`buildSpawnEnv`), git (`relay-command-env.ts`) and agent exec all do today. A module that snapshots `process.env` at import would silently freeze the agent.
- **Validate what a bridge reports.** Absolute path, resolves to a socket owned by the relay's uid, not the link itself; the link targets the resolved path so no chain can loop.

Not covered: Windows SSH hosts (the relay is WMI-launched with no session env), orcad / `orca serve` / paired clients (no SSH hop from the client exists), and relays started by a build without this binding (they keep their launch-time env until Reset Relay).

## Troubleshooting

`ssh-add -l` exit code 1 means an agent answered but holds no keys; exit code 2 means no agent could be reached. They point at different layers.

| Observation                                                                       | Layer                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Main log `Agent forwarding for <host>: off (not-requested)`                       | Intent: no `ForwardAgent` for this host and no per-host override.                                                                    |
| `off (no-agent-socket)`                                                           | Local: `IdentityAgent none`, an unset `$VAR`, or no `SSH_AUTH_SOCK` in Orca's own environment (a GUI launch does not read `.zshrc`). |
| `[ssh] <host> refused agent forwarding`                                           | Server: `AllowAgentForwarding no`, or `restrict` / `no-agent-forwarding` in `authorized_keys`. The connection keeps working.         |
| `relay.status` → `agentForwarding.bound: false`, `lastRejectReason` set           | The bridge reported a socket the relay refused; the reason names the check that failed.                                              |
| `bound: true`, but a shell's `SSH_AUTH_SOCK` differs from the `agent-*.sock` link | The shell overrode it (rc file, `keychain`, gpg-agent), or it was started while unbound or by an older relay.                        |
| `ssh-add -l` exits 1 remotely                                                     | Forwarding works; the local agent Orca forwards has no keys. Compare with `IdentityAgent` / 1Password / Secretive setup.             |
