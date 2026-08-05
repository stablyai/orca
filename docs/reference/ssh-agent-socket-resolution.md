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

`IdentitiesOnly yes` filters agent identities down to the local `IdentityFile` keys. When no local identity file parses (keys hosted only in the agent, e.g. 1Password), the raw agent is offered instead of silently disabling agent auth — a deliberate fail-open so agent-only keys keep working under `IdentitiesOnly`.
