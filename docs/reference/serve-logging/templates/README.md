# Orca Serve — Logging & Diagnostic Setup

Reproduce the headless `orca serve` logging and triage arrangement on any Linux/systemd
host in under 5 minutes. One script provisions the config layer and per-slot state tree
and wires log rotation + journal retention. It does **not** download or start the serve —
it arranges the *observability* surface only.

**The installer does not own the systemd unit.** `orca-serve@.service` is a template unit:
one file backs every slot on a host (`factory`, `canary`, `lesley`, `jessica`), and
`scripts/install.sh` is the owner of unit deployment. `install-logging-setup.sh` only
*seeds* the unit on a host that has none; if a unit already exists and differs from the
render it prints a bounded diff and exits `3` **without writing**. Overwriting is an
explicit opt-in (`--force-unit`), which first saves `orca-serve@.service.bak-<UTC>`.
The retention/plumbing layers install either way, so a host with a hand-maintained unit
still gets its logrotate snippet and journald drop-in.

```bash
sudo bash templates/orca-serve/install-logging-setup.sh --dry-run   # audit first, change nothing
sudo bash templates/orca-serve/install-logging-setup.sh             # then install
```

## 1. What lives where

**`templates/orca-serve/`** — the reproducible sources:

| File | Purpose |
|------|---------|
| `install-logging-setup.sh` | One-command installer / auditor (this setup) |
| `orca-serve@.service.template` | systemd instance unit; `@PREFIX@` is substituted at install |
| `orca-serve.conf.template` | Host-wide config (shared, loaded first) |
| `orca-serve-instance.env.template` | Per-slot config (loaded second, overrides host) |
| `orca-client-diagnostics.md` | Client-side reachability/pairing runbook (Bucket 4) |
| `test-logging-setup.sh` | Sandbox install + verify + idempotency + unit-drift refusal (run `bash templates/orca-serve/test-logging-setup.sh` from the repo root) |

**`docs/reference/serve-logging/`** — the operational docs:

| File | Purpose |
|------|---------|
| `orca-serve-logging-guide.md` | Architecture, env vars, sinks, client log locations |
| `orca-serve-troubleshooting-matrix.md` | Symptom → bucket → ≤5-command triage (Buckets 1–4) |

**`docs/reference/serve-logging/skills/`** — agent SRE & diagnostic skills:

| Skill | Purpose |
|-------|---------|
| `skills/orca-serve-troubleshoot/SKILL.md` | Headless `orca serve` 4-bucket triage, preflight & remediation |
| `skills/orca-diagnostics/SKILL.md` | General Orca desktop/client & PTY diagnostic skill |
## 2. Deploy in 5 steps

1. **Audit** — `sudo bash templates/orca-serve/install-logging-setup.sh --dry-run`. Fix any `FAIL` line.
2. **Install** — `sudo bash templates/orca-serve/install-logging-setup.sh` (uses `/data/opt/revive/orca_serve`).
   For `/opt/orca_serve`: `sudo INSTALL_PREFIX=/opt/orca_serve bash templates/orca-serve/install-logging-setup.sh`.
3. **Create the service account + group** (if the audit warned them missing):
   ```bash
   sudo groupadd --gid 1200 revive
   sudo useradd --system --uid 985 --gid revive --home-dir /data/opt/revive/orca_serve --shell /usr/sbin/nologin svc_orca
   ```
4. **Reload + enable** — the installer runs `daemon-reload`; then
   `sudo systemctl enable --now orca-serve@factory.service`.
5. **Verify** — run the 5 commands below; then `sudo systemctl restart systemd-journald`
   to apply the journal retention drop-in.

Config knobs (env or flags): `INSTALL_PREFIX`, `SYSTEMD_DIR`, `DEFAULT_SLOT`,
`LOGROTATE_DIR`, `JOURNALD_DIR`. Flags: `--prefix`, `--systemd-dir`, `--logrotate-dir`,
`--journald-dir`, `--slot`, `--dry-run`, `--force-unit`.
Exit codes: `0` ok · `1` preflight/fatal · `2` bad usage · `3` unit drift refused.

## 3. Five diagnostic commands

```bash
systemctl status orca-serve@factory.service --no-pager            # 137=OOM, 203=EXEC, active/…
journalctl -u orca-serve@factory.service -n 50 --no-pager         # serve's journal sink
tail -f /data/opt/revive/orca_serve/state/factory/logs/serve-fg.log   # tee file sink; SIGSEGV/SIGTRAP live here
ss -ltnp | grep -E ':(6768|6769|6770|6771|45175)'                   # who LISTENs + fallback-port trap
orca-serve-diag --phase after && logrotate -d /etc/logrotate.d/orca-serve   # snapshot + rotation validity
```

> Not sure which failure you have? Open the zero-guess index
> (`docs/reference/serve-logging/skills/orca-serve-troubleshoot/references/diagnostic-index.md`) first, then the
> `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` cheat sheet for the matching bucket.

---

## 4. Agent Diagnostic Skills Installation

Community users and AI agents can install the diagnostic skills directly into their environment:

### For Claude Code (`~/.claude/skills/`):
```bash
# Install orca-serve-troubleshoot (headless server triage)
mkdir -p ~/.claude/skills/orca-serve-troubleshoot/references
curl -fsSL https://raw.githubusercontent.com/LesleyMurfin/orca/feature/serve-logging-setup/docs/reference/serve-logging/skills/orca-serve-troubleshoot/SKILL.md \
  -o ~/.claude/skills/orca-serve-troubleshoot/SKILL.md
curl -fsSL https://raw.githubusercontent.com/LesleyMurfin/orca/feature/serve-logging-setup/docs/reference/serve-logging/skills/orca-serve-troubleshoot/references/diagnostic-index.md \
  -o ~/.claude/skills/orca-serve-troubleshoot/references/diagnostic-index.md

# Install orca-diagnostics (client & desktop diagnostics)
mkdir -p ~/.claude/skills/orca-diagnostics
curl -fsSL https://raw.githubusercontent.com/LesleyMurfin/orca/feature/serve-logging-setup/docs/reference/serve-logging/skills/orca-diagnostics/SKILL.md \
  -o ~/.claude/skills/orca-diagnostics/SKILL.md
```

### For Oh My Pi / Agents (`~/.omp/skills/` or `~/.agents/skills/`):
```bash
mkdir -p ~/.omp/skills/orca-serve-troubleshoot ~/.omp/skills/orca-diagnostics
cp -r ~/.claude/skills/orca-serve-troubleshoot/* ~/.omp/skills/orca-serve-troubleshoot/
cp ~/.claude/skills/orca-diagnostics/SKILL.md ~/.omp/skills/orca-diagnostics/
```