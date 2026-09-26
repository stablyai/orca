# templates/orca-serve/ — reproducible `orca serve` logging & diagnostics pack

Templates + installer to reproduce the `orca serve` logging/triage arrangement on any
Linux/systemd host in under 5 minutes. It arranges the **observability surface only** —
systemd instance unit, config layer, log rotation, journal retention — it does **not**
download or start the serve.

## What's here

- `install-logging-setup.sh` — one-command installer/auditor (`--dry-run` first);
  provisions the unit, config seeds, per-slot state tree, logrotate + journald drop-ins.
- `orca-serve@.service.template` — systemd instance unit; `@PREFIX@` substituted at install.
- `orca-serve.conf.template` — host-wide config, loaded first.
- `orca-serve-instance.env.template` — per-slot config, loaded second (overrides host).
- `orca-client-diagnostics.md` — client-side reachability/pairing runbook (Bucket 4).
- `test-logging-setup.sh` — sandbox install/verify/idempotency test (never touches production).
- `README.md` — the pack's own map: 5-step deploy + the 5 diagnostic commands.

## Where the real docs live

- [`../../docs/guides/orca-serve-logging-guide.md`](../../docs/guides/orca-serve-logging-guide.md) — architecture, env vars, sinks, client log locations.
- [`../../docs/guides/orca-serve-troubleshooting-matrix.md`](../../docs/guides/orca-serve-troubleshooting-matrix.md) — symptom → bucket → ≤5-command triage.
- Live (deployed) counterpart + its MOPs: [`../../orca/orca-serve/README.md`](../../orca/orca-serve/README.md) and [`../../orca/orca-serve/context.md`](../../orca/orca-serve/context.md).
- Repo model: [`../../README.md`](../../README.md) ("Factory operational tooling").

## Conventions specific to this folder

1. This is the **template** source; the deployed source lives in `orca/orca-serve/`. Edits here touch nothing live.
2. Nothing here is installed/deployed by an agent — deploy is a manual `sudo bash install-logging-setup.sh` (run `--dry-run` first).
3. `@PREFIX@` is a placeholder substituted at install time — never hardcode a prefix into a template.

## Ask

- `README.md` (this folder) for the deploy steps and diagnostic commands.
- [`../../docs/guides/orca-serve-troubleshooting-matrix.md`](../../docs/guides/orca-serve-troubleshooting-matrix.md) when a symptom appears.
- [`../../orca/orca-serve/context.md`](../../orca/orca-serve/context.md) for the live mtl-02 side.