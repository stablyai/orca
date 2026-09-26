---
name: orca-serve-troubleshoot
description: 'Automate Orca Serve logging installation, connectivity verification,
  and root-cause diagnostic triage across the 4 buckets (Orca Bug, Server Resource,
  Server Config, Client Config). Use when: diagnose orca serve, orca serve down,
  orca serve troubleshooting, install orca serve logging, orca connection refused,
  orca serve status, orca unknown environment. Does NOT trigger: orca-cli, orchestration,
  sre, generic server health.'
---

# Orca Serve Troubleshoot

## Purpose

Two-mode router for the headless `orca serve` runtime with zero-guess documentation mapping for Novice Admins, Expert Admins, and AI Agents.
- **Install / preflight mode** provisions the logging + diagnostics surface idempotently.
- **Triage mode** executes a non-destructive 5-command sequence and routes the issue deterministically to exactly one root-cause bucket and runbook.

## Fast Navigation Index (Zero-Guess Reference)

Before taking action or guessing, consult the authoritative lookup index:
- **Comprehensive Fast-Path Matrix**: `references/diagnostic-index.md`
- **Symptom -> Root Cause Matrix**: `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md`
- **Logging Architecture & Sinks**: `docs/reference/serve-logging/orca-serve-logging-guide.md`
- **Client Reachability & Pairing (Bucket 4)**: `docs/reference/serve-logging/templates/orca-client-diagnostics.md`

---

## Action 1 — Install / Preflight Mode

Triggered by: "install orca serve logging", "setup orca serve logging".

1. Locate `docs/reference/serve-logging/templates/install-logging-setup.sh`.
2. Always dry-run first — it audits and changes nothing:
   ```bash
   sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh --dry-run
   ```
   *(Note for non-root dry-run testing: use `--prefix <path> --systemd-dir <path>` to audit without requiring root).*
3. Check the exit code and read every `FAIL` line:
   - Exit `0` with only `WARN` lines → safe to apply.
   - Any `FAIL` line → resolve the hard-fail from the `preflight` output before installing.
4. Apply only when authorized:
   ```bash
   sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh [--slot <slot>] [--prefix <prefix>]
   ```
5. Verify the slot registers: `systemctl is-enabled orca-serve@<slot>.service`.

---

## Action 2 — Triage Mode (5-Command Sequence, Non-Destructive)

Triggered by: "diagnose orca serve", "orca serve down", "orca serve status",
"orca connection refused", "orca unknown environment".

Run all five over the failing slot (default `factory`) and capture output:

```bash
# 1. Check unit exit code and cgroup status (active vs status=137 OOM vs 203 EXEC)
systemctl status orca-serve@${SLOT:-factory}.service --no-pager -l

# 2. Grep journal for fatal crash signatures
journalctl -u orca-serve@${SLOT:-factory}.service -n 50 --no-pager

# 3. Read headless electron process log for SIGSEGV / SIGTRAP / unhandled rejections
tail -n 200 "${ORCA_SERVE_LOGDIR:-/data/opt/revive/orca_serve/state/factory/logs}/serve-fg.log"

# 4. Check who LISTENs and detect fallback port pre-emption (e.g. 45175 vs 6768)
ss -ltnp | grep -E ':(6768|6769|6770|6771|45175)'

# 5. Client's known environments vs serve's live runtime (diff runtimeId on each side)
cat ~/.config/orca/orca-environments.json 2>/dev/null    # client registry: environments[].name + .runtimeId
cat "$ORCA_CONFIG_DIR/orca-runtime.json" 2>/dev/null     # serve truth: runtimeId + pid
```

---

## Action 3 — Root-Cause Classification

Map the evidence to exactly one bucket from `references/diagnostic-index.md`:

| Evidence | Bucket | Target Runbook | Recommended Fix |
|----------|--------|----------------|-----------------|
| `SIGSEGV` / `SIGTRAP` / unhandled rejection in journal or serve-fg.log | **1 — Orca Bug** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §2 | Snapshot diag, check software GL (`LIBGL_ALWAYS_SOFTWARE=1`), clean stale `:99` lock, pin/roll back `ORCA_VERSION` |
| `status=137` (OOM/SIGKILL), `ENOSPC`, `EMFILE`, CPU starvation | **2 — Server Resource** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §3 | Raise unit `MemoryHigh`/`MemoryMax`/`LimitNOFILE`, inspect fd leaks, free disk |
| `status=203` (EXEC), port 6768 collision, stale fallback port 45175 | **3 — Server Config** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §4 | Fix `ExecStart`/mount, remove stale `$ORCA_CONFIG_DIR/mobile-ws-fallback-port.json`, free/pin port |
| env-id mismatch / stale `runtimeId` / connection refused | **4 — Client Config** | `docs/reference/serve-logging/templates/orca-client-diagnostics.md` | Reconcile env id (`ORCA_ENVIRONMENT`), test `nc -zv <addr> 6768`, relaunch client to refresh runtimeId |

*Never hand-edit `orca-runtime.json` to clear a phantom pid — that masks the crash, not the cause.*

---

## References

- **Comprehensive Index**: `references/diagnostic-index.md`
- **Troubleshooting Matrix**: `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md`
- **Logging Guide**: `docs/reference/serve-logging/orca-serve-logging-guide.md`
- **Client Diagnostics**: `docs/reference/serve-logging/templates/orca-client-diagnostics.md`
- **Setup Script**: `docs/reference/serve-logging/templates/install-logging-setup.sh`
