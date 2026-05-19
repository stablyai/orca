# Claude managed accounts — CLI and storage

Orca manages Claude provider credentials so multiple subscriptions, API keys, and
proxy providers can coexist. This page covers the headless CLI (for SSH/agent
sessions) and the encrypted-file fallback (for Linux/Windows or hardened macOS).

## CLI: `orca claude-accounts …`

All commands emit JSON when `--json` is set. Errors emit `{ "ok": false, "error": "…" }`
plus a non-zero exit code.

### Secret-handling contract

Secrets are **never** read from argv or stdin. The CLI accepts an env-var
**name** via `--key-env` / `--token-env`; Orca reads the value from
`process.env[<name>]`. This avoids leaking through:

- `ps`/`/proc/<pid>/cmdline` snapshots
- Shell history
- Orca's own terminal transcript capture
- Subprocess argv inherited by parent shells

### Providers

| Provider              | Required flags                                   | Secret flag        | Notes |
|-----------------------|--------------------------------------------------|--------------------|-------|
| `anthropic-api-key`   | `--label`                                        | `--key-env`        | Reads `sk-ant-…` from the named env var |
| `anthropic-compat`    | `--preset {zai\|kimi\|minimax\|custom}` `--label` | `--token-env`     | `custom` preset requires `--base-url` |
| `azure-foundry`       | `--resource` and (`--use-entra-id` or `--key-env`) | `--key-env` (optional) | Entra ID mode reads no secret; API-key mode reads from env |
| `aws-bedrock`         | `--region`                                       | `--token-env` (optional) | If omitted, uses IAM credential chain |
| `google-vertex`       | `--project-id` `--region`                        | none               | Uses Application Default Credentials |

### Examples

```bash
ANTHROPIC_API_KEY_INPUT=sk-ant-… \
  orca claude-accounts add --provider anthropic-api-key --label "Work" \
    --key-env ANTHROPIC_API_KEY_INPUT --validate --json

GLM_TOKEN=$(cat ~/.config/orca/secrets/glm) \
  orca claude-accounts add --provider anthropic-compat --preset zai \
    --label "GLM" --token-env GLM_TOKEN --json

orca claude-accounts add --provider azure-foundry --resource my-resource \
  --use-entra-id --json

orca claude-accounts list --json
orca claude-accounts select acct_xyz --json
orca claude-accounts remove acct_xyz --json
```

### Validate

Pass `--validate` to probe the provider after adding. On failure the account is
still saved (so you can fix and re-validate) but the CLI exits non-zero.

## Storage backends

On macOS, secrets live in the system Keychain (`security` CLI).

On Linux/Windows — or when macOS Keychain is unavailable or when
`ORCA_FORCE_ENCRYPTED_SECRETS=1` is set — Orca uses an encrypted-at-rest file at
`<userData>/claude-accounts/secrets.enc` (mode 0600).

**Crypto:**
- libsodium `crypto_secretbox` (XSalsa20 + Poly1305)
- Per-secret 24-byte random nonce
- Argon2id KDF (m=64 MB, t=3) with a 16-byte per-file random salt
- Passphrase prompted once per app launch via an Electron modal; held in
  main-process memory, never accessible to the renderer, zeroed on quit

For headless (no app) flows the passphrase is read from `ORCA_SECRETS_PASSPHRASE`
to avoid interactive prompts. **Never** put this in a script; pass it inline
(`ORCA_SECRETS_PASSPHRASE=… orca …`).

### Reset

If the passphrase is forgotten, use **Settings → Claude accounts → Reset
encrypted secrets** in the UI (a dedicated CLI verb is a planned P4.1 follow-up).
This **permanently wipes** all stored Claude account credentials. Account
records remain; you must re-add each.

## Troubleshooting

### Secret env var not set

```
{"ok":false,"error":"Environment variable ANTHROPIC_API_KEY_INPUT is not set"}
```

The CLI reads the secret from `process.env[<name>]`. Ensure the variable is
exported in the calling shell (or inline-prefixed on the command). Spaces around
`=` will silently produce an empty value — `VAR= orca …` is **not** the same as
`VAR=value orca …`.

### Keychain probe fails on macOS (passphrase modal appears)

The `security` CLI returned a non-zero status during runtime probing — usually a
denied prompt or a locked Keychain. Orca falls back to the encrypted-file
backend and prompts for a passphrase. To force this behavior on a healthy
Keychain (e.g. CI), set `ORCA_FORCE_ENCRYPTED_SECRETS=1`.

### Encrypted-file decrypt error after restart

```
Failed to decrypt secret: wrong passphrase or corrupted file
```

Either the passphrase was mistyped or the file at
`<userData>/claude-accounts/secrets.enc` was edited externally. If the
passphrase is genuinely forgotten, run the reset path described above.

### Headless CLI hangs on first call (Linux/Windows)

The encrypted-file backend needs a passphrase. Without `ORCA_SECRETS_PASSPHRASE`
and without a running app, there is no place to prompt. Either launch Orca
first (so the modal unlocks the holder), or set
`ORCA_SECRETS_PASSPHRASE=… orca claude-accounts …` inline.

### `--validate` returns non-zero but the account is listed

By design. Validation is best-effort; the account record is saved so you can
correct the credential and re-validate. Re-run `--validate` after fixing the
environment.
