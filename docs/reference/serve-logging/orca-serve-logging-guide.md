# Orca Serve Logging Guide

Reference for the headless `orca serve` runtime's logging architecture, client log
locations, and operational triage. This is the operational companion to the systemd
unit (`templates/orca-serve@.service.template`), the config layer
(`orca-serve.conf.template` / `orca-serve-instance.env.template`), and the troubleshooting
matrix (`orca-serve-troubleshooting-matrix.md`).

The runtime is **flag-driven**: every value below that changes by host or instance is
passed on the `orca serve` command line (or in the unit's `ExecStart=`), never baked into a
wrapper script.

---

## 1. Architecture

`orca serve` runs in the foreground and writes its startup and runtime output to
**stdout/stderr**. Under systemd the unit captures both to the journal, and the journal is
made durable with persistent storage. Operators who prefer a plain file can switch the unit
to an append file sink that logrotate manages.

| Sink | Accessor | Survives | Rotates |
|------|----------|----------|---------|
| **journald** (default) | `journalctl -u orca-serve@<instance>.service` | system restart (`Storage=persistent` drop-in) | journald vacuum policy (`MaxRetentionSec`, `SystemMaxUse`) |
| **serve.log** (optional) | `<logdir>/serve.log` via `StandardOutput=append:` | log dir on a data volume (never `/tmp`) | logrotate `daily` / `rotate 7` / `maxsize 10M` |

**One stream, one sink.** systemd's `StandardOutput=`/`StandardError=` each point a single
stream at one target, so pick the sink per unit. The default unit uses
`StandardOutput=journal` / `StandardError=journal`, which makes
`journalctl -u orca-serve@<instance>` a complete record of the serve's own words — the
pinned-port fallback notice, the bound endpoint, pairing status, and any
fuse/sandbox/GPU errors. The installer's journald drop-in sets `Storage=persistent` so that
record survives a reboot and is bounded by journald's retention caps.

To keep a durable **plain-file** sink instead (or in addition to the journal, on hosts that
mirror the journal elsewhere), set `StandardOutput=append:<logdir>/serve.log` and
`StandardError=append:<logdir>/serve.log` in the unit. The installer ships a logrotate
drop-in for `<prefix>/state/*/logs/*.log`, so the append target stays bounded and compressed
without any launcher-side rotation.

### Rotation (logrotate-owned)

The file sink is rotated by logrotate, not by the serve process:

```
<prefix>/state/*/logs/*.log {
    daily
    rotate 7
    maxsize 10M
    missingok
    notifempty
    copytruncate
    compress
    delaycompress
}
```

- Threshold: **10 MiB** (`maxsize`) with up to **7** daily copies retained.
- `copytruncate` keeps the open append fd valid across rotation (no reopen race).
- For long-term retention rely on the persistent journal, not on the file sink's longevity.

---

## 2. Command surface

`orca serve` accepts these flags (see `src/cli/specs/serve.ts` plus the global flags):

| Flag | Effect |
|------|--------|
| `--port <port>` | Pin the listener to a specific port. Pinned ports are preferred over any persisted fallback port (see §5). |
| `--pairing-address <host>` | Change only the **client-advertised** address. Use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint. Does not change the listener bind. |
| `--mobile-pairing` | Print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link. |
| `--no-pairing` | Start without minting a pairing offer. |
| `--project-root <path>` | Root of the project the serve should host (used with `--recipe-json`). |
| `--recipe-json` | With `--project-root`, print the recipe result JSON and leave the server running. |
| `--json` | Emit the versioned single-line `orca_server_ready` JSON contract instead of human text. |
| `--verbose` | Emit Electron/Chromium verbose logging to stderr (renderer, GPU, and network detail) for headless troubleshooting. |
| `--environment <id>` | Pin the client to a specific environment id (global flag; see §3). |
| `--pairing-code <code>` | Supply the remote pairing code (global flag; see §3). |

Read the ready block from the journal and require the readiness type before treating the
service as healthy:

```bash
journalctl -u orca-serve@<instance>.service -o cat \
  | jq -Rrc 'fromjson? | select(.type == "orca_server_ready" and .schemaVersion == 1)'
```

Client-side readiness and identity:

```bash
orca status --json                    # local runtime: .runtime.reachable, .runtime.runtimeId
orca --environment <id> status --json # remote runtime the client is pinned to
orca --version                        # client build version
```

The status payload lives at `.runtime.runtimeId`, `.runtime.appVersion`, and
`.runtime.reachable`; the resolved environment selector is `.target.environment` (for remote
targets).

---

## 3. Environment variables

Only these Orca variables are read anywhere in the runtime; everything else from the old
serve wrappers was config that upstream now takes as flags.

| Variable | Effect |
|----------|--------|
| `ORCA_ENVIRONMENT` | Ambient environment selector — the same value `--environment <id>` takes. Must match a `name` in the environment registry. |
| `ORCA_PAIRING_CODE` | Ambient remote pairing code — the same value `--pairing-code <code>` takes. |
| `ORCA_REMOTE_PAIRING` | Fallback alias for `ORCA_PAIRING_CODE` (checked only when `ORCA_PAIRING_CODE` is unset). |
| `ORCA_VERSION` | The version the launch command exports; used for version-skew identity (orcad remote launch hashes it). |
| `ORCA_USER_DATA_PATH` | Override the userData directory — how parallel Orca instances avoid clobbering one profile (see §4). |

`ORCA_WORKSPACE_ID` and `ORCA_WORKTREE_ID` are set by Orca inside agent processes to carry
the current worktree/workspace identity; they are not host configuration.

> **Reproduce at the source, not with a verbosity knob.** Upstream `orca serve` has no
> separate log-level switch — it writes what it writes to stdout/stderr. To reproduce a
> fault, pin the build you are chasing (`ORCA_VERSION`), capture the journal for the failing
> instance, and reproduce on a spare instance before changing the one under load.

> **Verbose Chromium logging.** `orca serve --verbose` is the first-class way to turn it on:
> it appends Chromium's `--enable-logging --v=1` switches before `ready`, surfacing
> renderer/GPU/network stderr for crash capture (matrix Buckets 1–2). The env-equivalent is
> `ELECTRON_ENABLE_LOGGING=1 orca serve`, which Electron maps to the same `--enable-logging`
> switch. On an Electron-direct launch, `--enable-logging=stderr --v=1` passes the switches
> through verbatim.

---

## 4. Client log locations

The **client** (desktop Orca app / CLI) is a different process from the headless **serve**.
Its userData/log layout follows the platform's Electron convention; `ORCA_USER_DATA_PATH`
overrides the userData root on any platform.

| Platform | Client logs / state | Notes |
|----------|---------------------|-------|
| **macOS** | `~/Library/Logs/orca/` (main process + renderer logs) · `~/Library/Application Support/orca/` (userData: `orca-runtime.json`, `orca-environments.json`, `orca-e2ee-keypair.json`, `crash-reports.json`, `Crashpad/`) | Console.app's `Orca` filter mirrors stderr. |
| **Windows** | `%USERPROFILE%\AppData\Roaming\orca\logs\` · `%APPDATA%\orca\` (userData, same files as macOS) | Pairing keypair and environment bindings live under the same tree — do not lose `orca-e2ee-keypair.json`. |
| **Linux** | `~/.local/share/orca/logs/` (serve log dir) · `~/.config/orca/` (userData: `profiles/local-default/orca-data.json`, `orca-runtime.json`, `orca-environments.json`, `crash-reports.json`, `Crashpad/`) | The headless serve run under a unit writes to the journal (or the configured append file), not to `~/.local/share`. |

`ORCA_USER_DATA_PATH` is how a systemd unit isolates parallel instances: point it at the
instance's state directory and the runtime metadata, environment registry, and keypair all
live there instead of the user's default profile.

---

## 5. Transport layer

Two transports serve the same runtime, dispatched by the client based on `--environment` /
`ORCA_ENVIRONMENT`:

```text
 Remote client ── ws://<addr>:6768 ──► [ WebSocketTransport  +  TLS  +  E2EE ]  ──► orca serve
                       (paired)
 Local CLI / agent ─► unix socket runtime.sock ─► [ UnixSocketTransport ]           ──► orca serve
                       (same host)
```

| Transport | Endpoint | When used | Security |
|-----------|----------|-----------|----------|
| **WebSocket** | `ws://<pairing-address>:<port>` (forwarded / overlay IP, or `wss://` through a proxy) | Remote desktops/CLIs pair to the serve over the network | TLS on the hop when proxied (`wss://`); payload is **E2EE** — the client/server keypair minted at first pair encrypts traffic end-to-end so an intermediary cannot read commands. |
| **Unix domain socket** | `runtime.sock` under the userData dir (`$ORCA_USER_DATA_PATH/runtime.sock`) | Local CLI/agents on the serve host (fast path, no network) | File-system permissioning (userData dir) — no network exposure. |

**Port pinning & the fallback-port trap.** When the preferred port is taken (a second Orca
instance), the OS assigns a random port, and paired mobile devices store the `ws://ip:port`
endpoint. Orca persists that assigned fallback to `<userData>/mobile-ws-fallback-port.json`
so the same instance re-binds the same port next launch (`candidatePorts = [fallback,
pinned]`, STA-1511). The trap: a **stale** fallback file can make serve bind the remembered
port and never the port you asked for. Upstream resolves this at the flag level — with
`serve --port`, the pinned port is preferred *first* (`preferPinnedPort`, issue #8535), so a
stale fallback cannot steal the pin. Only when the pinned port is genuinely unavailable does
the fallback persist and win again, which is what keeps existing pairings working.

**Pairing & key material.** On first pair the client and serve mint an E2EE keypair
(`orca-e2ee-keypair.json`) and a device token. These **survive version swaps and restarts** —
a version-swap or restart is a session rebuild, not a re-pair — but a restart mints a **new
runtimeId**, which a stale client pins to (the "stale pairing id / stale
`activeRuntimeEnvironmentId`" failure class, covered in the matrix).

---

## 6. Quick references

```bash
# Journal for one instance (serve's own words)
journalctl -u orca-serve@<instance>.service -b --no-pager -n 200

# Latest crash signatures since yesterday
journalctl -u orca-serve@<instance>.service --since "24 hours ago" -o cat \
  | grep -iE 'SIGTRAP|SIGSEGV|SIGKILL|Unhandled|uncaught'

# Optional file sink (only if the unit uses StandardOutput=append:)
tail -n 200 <prefix>/state/<instance>/logs/serve.log

# Client-side identity against the serve truth
orca --environment <id> status --json | jq '.runtime | {runtimeId, appVersion, reachable}'
cat "$ORCA_USER_DATA_PATH/orca-runtime.json" 2>/dev/null || cat ~/.config/orca/orca-runtime.json
```
