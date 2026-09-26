---
type: reference
skill_id: orca-serve-troubleshoot
reference_id: diagnostic-index
status: active
version: 1.0.0
created: 2026-09-10
description: "Zero-guessing symptom-to-root-cause router for the headless orca serve runtime (4 buckets) — fast-path discriminator, lookup table, and per-persona guides for Novice Admins, Expert Admins, and AI Agents."
---

# Orca Serve Diagnostic Quick-Reference Index (Zero-Guessing Router)

Authoritative reference mapping symptoms directly to root causes, precise file locations, and verification commands.

## 1. Fast-Path Symptom Discriminator

Execute these commands in order. The first pattern matched dictates the bucket and target runbook:

```bash
# Command 1: Inspect unit exit code and status
systemctl status orca-serve@${SLOT:-factory}.service --no-pager -l

# Command 2: Grep journal for fatal crash signatures
journalctl -u orca-serve@${SLOT:-factory}.service -n 50 -o cat --no-pager | grep -iE 'SIGSEGV|SIGTRAP|UnhandledPromiseRejection|uncaughtException|RuntimeEnvironmentStoreError'

# Command 3: Check listener and port collisions
ss -ltnp | grep -E ':(6768|6769|6770|6771|45175)'

# Command 4: Check file sink for headless electron output
tail -n 100 ${ORCA_SERVE_LOGDIR:-/data/opt/revive/orca_serve/state/factory/logs}/serve-fg.log 2>/dev/null
```

---

## 2. Deterministic Root-Cause & Documentation Index

| Observed Output / Signature | Root Cause | Bucket | Target Documentation & Section | Immediate Remediation Command |
|---|---|---|---|---|
| `code=exited, status=137` or `killed process` in `dmesg` | CGroup MemoryHigh/MemoryMax limit exceeded or host OOM | **Bucket 2: Server Resource** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §3 (Bucket 2) | Raise `MemoryHigh`/`MemoryMax` (unit template, or its `*.service.d/` drop-in on live hosts) or check leak with `ls /proc/<pid>/fd | wc -l` |
| `Failed at step EXEC`, `status=203` | ExecStart binary missing, unexecutable, or unmounted path | **Bucket 3: Server Config** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §4 (Bucket 3) | `systemd-analyze verify /etc/systemd/system/orca-serve@.service` and verify binary permissions |
| Listener on port `45175` instead of `6768` | Stale fallback port override persisted before startup | **Bucket 3: Server Config** | `docs/reference/serve-logging/orca-serve-logging-guide.md` §4 (Transport Layer) | `rm -f $ORCA_CONFIG_DIR/mobile-ws-fallback-port.json && systemctl restart orca-serve@<slot>` |
| Another PID already listening on `6768` | Port collision / Dual-serve split-brain | **Bucket 3: Server Config** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §4 (Bucket 3) | Identify PID with `ss -ltnp | grep 6768` and terminate stray instance |
| `SIGSEGV` in main process or Xvfb lock failure | Stale `:99` lock file or GPU-less host missing software GL | **Bucket 1: Orca Bug** | `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md` §2 (Bucket 1) | Ensure `LIBGL_ALWAYS_SOFTWARE=1` in `orca-serve.conf` and clean stale `/tmp/.X99-lock` |
| `SIGTRAP` or `WebGL2 blocklisted` | Renderer crash due to missing GPU emulation | **Bucket 1: Orca Bug** | `docs/reference/serve-logging/orca-serve-logging-guide.md` §2 (Env Vars) | Set `LIBGL_ALWAYS_SOFTWARE=1` in `orca-serve.conf` |
| Client error: `Unknown environment: <id>` | Client environment registry id mismatch vs serve runtime | **Bucket 4: Client Config** | `docs/reference/serve-logging/templates/orca-client-diagnostics.md` §2 | Set `ORCA_ENVIRONMENT` in `orca-serve.conf` to match client's `--environment <id>` |
| Client error: `Connection refused` | Serving on overlay/WireGuard IP but client dialing localhost | **Bucket 4: Client Config** | `docs/reference/serve-logging/templates/orca-client-diagnostics.md` §1 | Test `nc -zv <pairing-address> 6768`; verify WSL2 `localhostForwarding=true` |
| Stale `runtimeId` after server restart ("disconnected, retrying") | Client pinning pre-restart runtime session | **Bucket 4: Client Config** | `docs/reference/serve-logging/templates/orca-client-diagnostics.md` §4 | Compare `orca --environment <id> status --json` vs serve's `orca-runtime.json` and relaunch client |
| `not writable by this user: /etc/systemd/system` | Non-root dry-run or install execution | **Admin Permission** | `docs/reference/serve-logging/templates/README.md` §2 | Use `sudo` for install, or test with `--prefix /custom/path --systemd-dir /custom/path` |

---

## 3. Persona Navigation Guides

### For Novice Admins (Zero-Guessing Step-by-Step)
1. **Audit First**: Run `bash docs/reference/serve-logging/templates/install-logging-setup.sh --dry-run`.
2. **If installing**: Run `sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh`.
3. **If down**: Run the 4 fast-path commands in Section 1 above. Match the line in the table in Section 2, open the linked markdown document, and paste the exact command from the table.

### For Expert Admins (Architecture & Tunables)
- **Unit Configuration**: See `docs/reference/serve-logging/templates/orca-serve@.service.template`.
  - Tunables (template defaults — per-host deployments override via `*.service.d/` drop-ins):
    `MemoryHigh=6G`, `MemoryMax=8G`, `LimitNOFILE=16384`, `TasksMax=512`.
    Live hosts commonly raise these — mtl-02 runs `MemoryHigh=32G`/`MemoryMax=48G`/
    `LimitNOFILE=524288`/`TasksMax=16384` via `20-resource-ceiling.conf` + `40-tasksmax.conf`.
  - Sinks: `StandardOutput=journal`, launcher `tee` to `$ORCA_SERVE_LOGDIR/serve-fg.log`.
- **Log Rotation**: Launcher handles inline 10MB rotation (`serve-fg.log.1`). System logrotate handles 7-day compressed retention via `/etc/logrotate.d/orca-serve`.
- **Journal Retention**: Persistent journal capped to `500M`, `2week` retention via `/etc/systemd/journald.conf.d/orca-serve.conf`.

### For AI Agents (Structured Determinism)
- **Zero-Guess Invariant**: Never guess environment IDs or ports. Query `$ORCA_CONFIG_DIR/orca-runtime.json` or `systemctl show -p Environment orca-serve@<slot>`.
- **Diagnosis Output Format**: When reporting diagnostics, always output:
  1. Primary Symptom & Matched Bucket (1, 2, 3, or 4).
  2. Concrete Evidence (stdout, exit code, log line).
  3. Action taken / proposed from the Section 2 table.
  4. Post-action verification command.
