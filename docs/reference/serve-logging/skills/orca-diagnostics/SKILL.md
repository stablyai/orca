---
name: orca-diagnostics
description: >-
  Diagnose and troubleshoot Orca issues (app freezes, SSH reconnection hangs,
  daemon/PTY desync, renderer crashes, and configuration errors) using internal
  error traces, detached daemon logs, OpenSSH socket inspection, and CDP remote
  debugging. Also configures Orca settings on disk. Triggers on: "diagnose orca",
  "orca slow reconnect", "orca frozen", "orca ssh hang", "orca bug or config",
  "troubleshoot orca", "fix orca connection", "configure orca settings".
---

# Orca Diagnostics & SRE

Use this skill when Orca behaves unexpectedly, hangs on reconnect, drops terminal sessions, or when troubleshooting whether an issue is an OS environment problem, a configuration error, or an
internal Orca bug.

---

## 1. Quick Classification Gate (Step 0)

Before diagnosing, classify the issue into one of three buckets:

| Domain | Signs | Verification Test |
| :--- | :--- | :--- |
| **Environment** | OS sleep/wake, VPN/Tailscale shifts, zombie SSH sockets, PATH issues. | Run the identical command in the native OS terminal. If it also fails → Environment. |
| **Configuration** | Scoped to a specific project, wrong SSH key, bad `orca.yaml`, broken hook. | Open an empty directory workspace in Orca. If it works there → Configuration. |
| **Orca Bug** | Electron IPC rejections, renderer white-screen, daemon crash loops. | Inspect `main.trace.ndjson` for unhandled exception stack traces. |

---

## 2. Platform Telemetry Map

Locate Orca's telemetry directories on the host:

```text
macOS:
  Logs:     ~/Library/Application Support/Orca/logs/
  Files:    main.trace.ndjson (error spans), daemon.log (PTY lifecycle)
  Sockets:  /tmp/orca-ssh-<UID>/ or $TMPDIR/orca-ssh-<UID>/
  DevTools: ⌥⌘I
  Power:    pmset -g log | tail -n 50 | grep -E "Sleep|Wake"
  Settings: ~/Library/Application Support/Orca/orca-data.json

Linux:
  Logs:     ~/.config/Orca/logs/
  Files:    main.trace.ndjson & daemon.log
  Sockets:  /tmp/orca-ssh-<UID>/
  DevTools: Ctrl+Shift+I
  Power:    journalctl -u systemd-suspend
  Settings: ~/.config/Orca/orca-data.json

Windows:
  Logs:     %APPDATA%\Orca\logs\
  Files:    main.trace.ndjson & daemon.log
  Sockets:  Named pipes / OpenSSH win
  DevTools: Ctrl+Shift+I
  Power:    powercfg /lastwake
  Settings: %APPDATA%\Orca\orca-data.json
 ```

 ────────────────────────────────────────────────────────────────────────────────

 3. Diagnostic Standard Operating Procedure (SOP)

 ### Step 1: Read Application Logs

 1. Identify the operating system and set $LOG_DIR.
 2. Inspect the last 100 lines of $LOG_DIR/main.trace.ndjson for ERROR spans or IPC call rejections.
 3. Inspect the last 100 lines of $LOG_DIR/daemon.log for session-detached, session-kill-failed, or endpoint-ownership-lost.

 ### Step 2: Audit Background Processes & Sockets

 1. Dead SSH Mux Sockets: Check for stale UNIX sockets with lsof -U 2>/dev/null | grep orca-ssh.
 2. Zombie SSH Processes: Run ps aux | grep -E '[s]sh.*(ControlMaster|orca)'.
 3. OS Sleep/Wake Correlation: Compare timestamps between the sleep event and the log drop.

 ### Step 3: Inspect Renderer via CDP or DevTools

 1. If Orca was launched with --remote-debugging-port=9222, query http://127.0.0.1:9222/json to inspect the active renderer session.
 2. Check for failing WebSocket handshakes, unhandled client promises, or high UI thread latency.

 ### Step 4: Settings Inspection & Offline Editing

 1. Live Discovery: If user asks "How do I do [X] in Orca?", query registered commands and capabilities rather than reading external documentation.
 2. Offline Disk Editing: If Orca is closed, safely edit global settings at orca-data.json or workspace settings in orca.yaml:
   - Validate JSON syntax before saving.
   - Never write to orca-data.json while Orca is actively running (app write will overwrite agent changes).

 ────────────────────────────────────────────────────────────────────────────────

 4. Common Remediation Recipes

 ### Recipe A: Post-Sleep SSH Reconnection Hang

 - Cause: OpenSSH ControlMaster keeps a dead UNIX socket after network changes.
 - Fix: Clear the stale socket and kill the background master without quitting Orca:
   ```bash
find /tmp -name "orca-ssh*" -exec rm -rf {} + 2>/dev/null
pkill -f "ssh.*ControlMaster"
   ```
 - Permanent Prevention: Add to client's ~/.ssh/config:
   ```sshconfig
Host *
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ControlMaster auto
    ControlPersist 10m
   ```

 ### Recipe B: Daemon Endpoint Lost / PTY Freeze

 - Cause: Detached terminal daemon process died or retired due to timeout.
 - Fix: Check daemon.log for retirement status, kill orphaned daemon processes, and reopen the pane to re-spawn the socket.  