# 1Password Secret References in Tab Environments

Opt-in integration that resolves [1Password secret references](https://developer.1password.com/docs/cli/secret-references/) (`op://vault/item/field`) in terminal tab environment variables at launch, via the 1Password CLI (`op`).

## How it works

With **Settings → Integrations → 1Password** enabled, any local tab whose spawn environment contains at least one `op://` value has its startup command wrapped:

```text
op run -- <command>
```

`op run` executes inside the tab's own shell, substitutes every `op://` env var with the secret it points to, and starts the command. Orca's main process never executes `op` and never resolves or stores secret values — resolution happens inside the PTY, in the child's environment. Terminal output still flows back through the PTY like any other output; as a safeguard, `op run` masks secret values it detects in that output by default (`<concealed by 1Password>`). Orca never disables masking — but users can via `--no-masking` or `OP_RUN_NO_MASKING`, at their own risk.

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
- **Windows chained commands.** Commands containing shell metacharacters — or leading `FOO=bar` assignments — are wrapped via `sh -c` on POSIX; on Windows there is no portable single-line quoting, so chained commands are left unwrapped. This is keyed off the host platform, so a Git Bash pane on Windows is treated as Windows and also left unwrapped even though `sh -c` would work there.
- **Environment values are capped by the generic 64 KiB orca.yaml field limit,** which is larger than the 32,767-character maximum Windows allows for a single environment variable. The cap is deliberately platform-independent: `parseOrcaYaml` feeds the command-trust hash, so a platform-dependent parse would change that hash between macOS and Windows and re-prompt on every switch. A value above the Windows limit therefore parses everywhere but can fail at spawn time on Windows.
- **Setup scripts and environment-recipe lifecycle scripts** are not covered yet (planned follow-up). Recipes run from the main process, so their `op` path additionally needs the macOS TCC login-shell attribution wrapper.

## Command trust and the one-time re-prompt

Committed `defaultTabs[].env` is trust-gated exactly like a committed `command`: it is
serialized into the setup trust content, hashed, and injected only once the user approves
that hash. Main and renderer share one implementation
(`src/shared/default-tab-trust-content.ts`) so a change trusted on one side cannot be
silently accepted by the other.

The format separates structure from free text by indentation — `# setup` and
`# defaultTabs[N]` headers sit at column 0, `env KEY=value` lines at one indent, and every
byte of user free text (setup scripts, tab commands) at two. Without that separation a
`command:` beginning `NODE_OPTIONS=…` hashes identically to a real `env:` entry, and only
the latter exports the variable into the spawned PTY — so an approved hash could later
activate `NODE_OPTIONS` or `LD_PRELOAD` with no re-prompt. Indenting free text also stops a
command or setup script from forging an extra `# defaultTabs[N]` block, which was possible
before this change.

Adopting the format changes the hash of every repo that has a setup script or default tabs,
so each one re-prompts once after upgrade. That is a deliberate one-time cost, not a
regression.

## Why in-PTY instead of resolving in the main process

Orca-spawned `op` subprocesses historically triggered macOS TCC permission-prompt storms because tccd attributed each grant to Orca's bundle id (#6996, #8985, #12534); the fix wraps PTY shells in `login(1)` so children keep their own TCC identity (`src/main/providers/macos-tcc-login-shell.ts`). Running `op` from the main process would bypass that wrapper and revive the storm — and would put secret values in Orca's process memory. The in-PTY wrap avoids both.
