# 1Password Secret References in Tab Environments

Opt-in integration that resolves [1Password secret references](https://developer.1password.com/docs/cli/secret-references/) (`op://vault/item/field`) in terminal tab environment variables at launch, via the 1Password CLI (`op`).

## How it works

With **Settings → Integrations → 1Password** enabled, any local tab whose spawn environment contains at least one `op://` value has its startup command wrapped:

```
op run -- <command>
```

`op run` executes inside the tab's own shell, substitutes every `op://` env var with the secret it points to, and starts the command. Orca never executes `op` itself and never sees secret values — resolution happens entirely inside the PTY. `op run`'s default output masking is kept, so resolved values that would appear in terminal output are redacted by the CLI.

Declare refs per tab in `orca.yaml`:

```yaml
defaultTabs:
  - title: Claude
    command: claude
    env:
      ANTHROPIC_API_KEY: op://Private/Anthropic/api-key
```

References are inert pointers, not secrets — committing them is safe. Because committed `env` can redirect binaries (`PATH`) or pull arbitrary vault fields, it participates in the same command-trust gate as committed `defaultTabs` commands: tabs inject `env` only when the workspace's shared commands are trusted to run, and changing `env` re-prompts trust.

Values in the per-agent default env settings (`agentDefaultEnv`) flow through the same wrap.

## Prerequisites

- The `op` CLI installed and on the shell's PATH ([install guide](https://developer.1password.com/docs/cli/get-started/)).
- 1Password desktop-app integration enabled (1Password → Settings → Developer → "Integrate with 1Password CLI") so `op` unlocks biometrically. The first resolution in a session raises the 1Password authorization prompt.

If `op` is missing, the tab prints `op: command not found` — the integration is explicit opt-in, so failures are loud rather than silently unwrapped.

## Scope and limitations

- **Local spawns only.** Remote (SSH) tabs and runtime-owned (per-workspace environment) tabs are never wrapped — `op` is a local-machine assumption. Their env keeps any `op://` strings as literals.
- **Command-less tabs are not wrapped.** A plain shell tab with `op://` env keeps the literal refs; run `op run -- <cmd>` manually.
- **Windows chained commands.** Commands containing shell metacharacters are wrapped via `sh -c` on POSIX; on Windows there is no portable single-line quoting, so chained commands are left unwrapped there.
- **Setup scripts and environment-recipe lifecycle scripts** are not covered yet (planned follow-up). Recipes run from the main process, so their `op` path additionally needs the macOS TCC login-shell attribution wrapper.

## Why in-PTY instead of resolving in the main process

Orca-spawned `op` subprocesses historically triggered macOS TCC permission-prompt storms because tccd attributed each grant to Orca's bundle id (#6996, #8985, #12534); the fix wraps PTY shells in `login(1)` so children keep their own TCC identity (`src/main/providers/macos-tcc-login-shell.ts`). Running `op` from the main process would bypass that wrapper and revive the storm — and would put secret values in Orca's process memory. The in-PTY wrap avoids both.
