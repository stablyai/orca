# Local Multi-Host Test Modes

Reproduce Orca's execution-host topologies on a single machine so features can be
exercised the way users hit them — not just locally. This exists because bugs
like a runtime-server-only native-chat failure are invisible when you can only
test the local host.

One orchestrator drives every mode:

```bash
pnpm dev:mode <mode> [flags]
```

It composes the existing building blocks (`run-electron-vite-dev.mjs`,
`serve-headless-fresh-profile-pairing.mjs`, `orca-dev.mjs`); it does not
reimplement them. Source: [`config/scripts/local-test-modes.mjs`](../config/scripts/local-test-modes.mjs).

## Modes

| Mode | Launches | What it's for |
|---|---|---|
| `local` | one desktop app (local host) | Baseline; the default `pnpm dev` experience with an isolated profile. |
| `remote` | headless `orca serve` runtime + an auto-paired **web** client | Exercise a conversation that lives entirely on a remote Orca Server (execution host `runtime:<env>`). |
| `local-remote` | desktop app **+** a runtime server, pre-added to the app | Mixed: local repos alongside a remote server in one desktop window. |
| `local-ssh` | desktop app **+** localhost-SSH prep | Local repos alongside an `ssh:<target>` host. |
| `local-remote-ssh` | desktop **+** runtime server **+** SSH prep | All three host kinds at once. |

Each host gets its **own isolated `userData` profile** under a short
`/tmp/orca-modes/<runId>/<arm>` path, so instances never share state and never
collide. Ports: the desktop app uses the dev default (ws 6769); the runtime
server uses **6780** (avoiding 6768 packaged / 6769 dev).

## Prerequisites

- `pnpm install` (once). The orchestrator auto-builds anything a mode needs and
  is missing: `build:cli`, `build:electron-vite` (the `out/main` bundle `orca
  serve` loads — `electron-vite dev` does **not** produce it), `build:web` (so
  the server can serve the web client), and `build:relay` (SSH). Pass
  `--no-build` to skip when you know the artifacts are current.
- **node-pty / compiler (macOS):** every launch rebuilds `node-pty` for the
  Electron ABI. If a non-Apple `c++` (e.g. a corporate GCC) is first on `PATH`,
  the source build fails with `unrecognized command-line option '-stdlib=libc++'`.
  The harness defaults `CC`/`CXX` to `/usr/bin/clang(++)` on macOS when unset to
  avoid this. If you still hit it, install the Xcode Command Line Tools
  (`xcode-select --install`) and make sure `CC`/`CXX` aren't pointed at GCC.
- **`local-ssh` / `--ssh=localhost`:** a reachable sshd with non-interactive
  (key or agent) auth. On macOS: `sudo systemsetup -setremotelogin on`, then
  verify `ssh -o BatchMode=yes localhost true` succeeds.
- **`--ssh=docker`:** Docker installed and running.

## Runbook

```bash
# See the plan (arms, ports, profiles) without launching anything:
pnpm dev:mode local-remote --dry-run

# Local host only:
pnpm dev:mode local

# Remote Orca Server + auto-paired web client (opens your browser):
pnpm dev:mode remote

# Local + remote server, pre-added to the desktop app:
pnpm dev:mode local-remote

# Local + a localhost SSH host (prep only; add the host in-app — see below):
pnpm dev:mode local-ssh          # or: pnpm dev:mode local-ssh --ssh=docker

# Everything at once:
pnpm dev:mode local-remote-ssh
```

`Ctrl+C` stops every arm and removes the temp profiles (pass `--keep` to retain
them for inspection).

### What's automated vs. one manual step

| Step | Automated? |
|---|---|
| Build prerequisites, isolated profiles, process-group teardown | ✅ |
| `remote`: start server + open the auto-pairing web client | ✅ (the web client pairs from the URL fragment with no paste) |
| `local-remote`: add the server to the desktop's saved list (`orca environment add`) | ✅ |
| `local-remote`: **activate** that server in the desktop | ⛱️ one click — **Settings → Runtime Environments → connect "mode-remote"**. There is no CLI/env seam to set the active runtime environment; activating it also fetches the server's repos so they route to `runtime:<env>`. |
| `local-ssh`: build relay + reachability check | ✅ |
| `local-ssh`: add/connect the SSH host | ⛱️ in-app — **sidebar → Add → Remote host (SSH)** → host `127.0.0.1`, your user, your key. |

## Troubleshooting

- **Port already in use:** a previous run left a server up. `lsof -ti tcp:6780 |
  xargs kill`, or the desktop dev port (6769).
- **macOS `listen EINVAL … daemon-v24.sock`:** the daemon binds
  `<profile>/daemon/daemon-v24.sock` and macOS caps UNIX socket paths at ~104
  bytes. The harness anchors profiles at a short `/tmp` path for exactly this
  reason — don't point profiles at the OS temp dir (`/var/folders/…`), which
  already overflows the limit and forces non-persistent local PTYs.
- **Pairing URL is a bearer credential.** The `orca://pair?code=…` the server
  prints embeds a device token that grants full access — treat server stdout as
  secret; don't paste it into shared logs.
- **No "Web client URL":** the server only serves one when `out/web` exists.
  Re-run without `--no-build`, or `pnpm build:web`.

## Adding a mode / combination

Modes are declarative in `config/scripts/local-test-modes.mjs`:

```js
const MODES = {
  'local-remote': { arms: ['serve', 'desktop'], seedRemote: true },
  // add e.g. a two-server combo:
  // 'remote-remote': { arms: ['serve', 'serve'], seedRemote: false },
}
```

The orchestrator loops arms generically (`desktop` / `serve` / `web` / `ssh`), so
new combinations are data, not new launch code. Give each additional `serve` arm
a distinct port.

## Cross-platform notes

- **macOS:** `orca serve` is windowless (no DISPLAY/Xvfb). Dev instances share
  one bundle id, so notification-click routing across simultaneous desktops is
  ambiguous — fine for testing.
- **Linux:** a `serve` arm needs Xvfb + libfuse2 for browser panes (see
  [`docs/reference/headless-linux-server.md`](./reference/headless-linux-server.md));
  the harness sets `ELECTRON_DISABLE_SANDBOX=1` for temp dev profiles.
- **Windows:** SSH modes are POSIX-only; use `local` / `remote`. Teardown uses
  `taskkill /t /f`. All profile paths use `path.join`.
