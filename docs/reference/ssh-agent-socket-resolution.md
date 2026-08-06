# SSH Agent Socket Resolution

How Orca picks the SSH agent socket for `ssh2` connections (`src/main/ssh/ssh-auth-resolution.ts`).

## Resolution order

1. **Explicit `IdentityAgent`** from the target or resolved OpenSSH config. Always wins; `IdentityAgent none` disables agent auth.
2. **Probed socket** — once per connect attempt (`src/main/ssh/ssh-agent-socket-probe.ts`), Orca asks each candidate socket for its identities and uses the first that reports ≥1 key:
   - `$SSH_AUTH_SOCK` from the environment
   - the 1Password agent socket: `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` (macOS), `~/.1password/agent.sock` (Linux; absent under Flatpak/Snap installs), `\\.\pipe\openssh-ssh-agent` (Windows — 1Password serves the standard pipe)
   Each candidate probe is bounded at 500 ms; failures count as zero keys. No caching across attempts, so locking or restarting 1Password self-heals on the next connect.
3. **Environment fallback** — `$SSH_AUTH_SOCK`, else the Windows OpenSSH pipe. Identical to pre-probe behavior when nothing holds keys.

## Why the probe exists

GUI-launched Electron inherits launchd's environment on macOS: `SSH_AUTH_SOCK` points at Apple's default agent, which is empty when keys live in 1Password. Without the probe, agent auth fails and Orca falls back to reading the on-disk encrypted key — producing a passphrase prompt the user's terminal `ssh` never shows.

## Shell hydration

At packaged startup (macOS/Linux), the login-shell probe in `src/main/startup/hydrate-shell-path.ts` also captures `$SSH_AUTH_SOCK` and exports it into the main process when the user's rc files set a different value than the inherited one. This benefits the system-`ssh` transport (spawned processes inherit the env) and `IdentityAgent SSH_AUTH_SOCK` expansion.

## IdentitiesOnly and agent-only keys

`IdentitiesOnly yes` filters agent identities down to the local `IdentityFile` keys. When no identity file yields a usable key, the fallback depends on whether the paths were configured *explicitly* — `ssh -G` injects the `~/.ssh/id_*` defaults even when the user configured nothing, so default paths alone are not treated as a deliberate restriction:

- **Only implicit default paths (or none at all)**, none of which parse (keys hosted only in the agent, e.g. 1Password): the raw agent is offered instead of silently disabling agent auth — a deliberate fail-open so agent-only keys keep working under `IdentitiesOnly`.
- **An explicitly configured `IdentityFile` fails to parse**: agent auth stays disabled (`config.agent` is `undefined`), matching OpenSSH's fail-closed behavior. A configured-but-broken key is treated as a configuration error, not a signal to fall back to the unfiltered agent.

## Limitation: mixed agents

The probe selects the first candidate socket that reports *any* key, not the socket holding the key for the current host. If `$SSH_AUTH_SOCK` points at an agent with unrelated keys, it wins over the 1Password socket even when the host's key lives in 1Password. Hosts that need a specific agent should set `IdentityAgent` explicitly rather than relying on probe order.
