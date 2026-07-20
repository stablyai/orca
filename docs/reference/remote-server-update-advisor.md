# Remote Server Update Advisor

## Decision

Build a remote server update advisor before building any remote self-update
executor.

When the protocol compatibility gate blocks a paired Orca server, Orca should
tell the user what is wrong, identify the server version and likely install
shape when it can, and provide copyable platform-specific update guidance. The
client must not download, install, restart, or run privileged commands on the
remote machine in this design — not even over an SSH connection Orca already
holds.

The advisor covers **both block directions** reported by
`evaluateRuntimeCompat` (`src/shared/protocol-compat.ts`):

- `server-too-old`: show the remote update guidance described in this doc.
- `client-too-old`: do not show server guidance. Route to the local update
  flow — the desktop updater (`src/main/updater.ts`) on desktop, the app-store
  update message on mobile.

The first implementation adds optional server-side metadata now, but treats it
as advisory and untrusted:

```ts
type RuntimeUpdateInfo = {
  currentVersion?: string | null
  latestVersion?: string | null
  updateAvailable?: boolean | null
  installKind?: RuntimeInstallKind
  restartKind?: RuntimeRestartKind
  serviceName?: string | null
  installPath?: string | null
  hostArch?: string | null // process.arch, e.g. 'x64' | 'arm64'
  docsUrl?: string
}

type RuntimeInstallKind =
  | 'mac-app'
  | 'mac-homebrew'
  | 'windows-installer'
  | 'linux-appimage'
  | 'linux-deb'
  | 'linux-rpm'
  | 'source'
  | 'unknown'

type RuntimeRestartKind = 'desktop' | 'foreground-serve' | 'systemd' | 'unknown'
```

The protocol compatibility gate remains the sole source of truth for whether a
client can use the server. `latestVersion` and `updateAvailable` improve the
prompt, but the app must render useful guidance when every field is absent.

## Problem

Remote Orca servers can be desktop apps, headless Linux AppImages, systemd
services, Windows machines, deb/rpm package installs, or source builds. A
client that only says "update the server" leaves users stranded at the exact
moment the app is blocked. A client that attempts to update the server
automatically risks running the wrong package manager, requiring `sudo`,
breaking a service, or mutating a machine the user did not intend to touch.

The right first step is to make the blocked state actionable without taking
control of the remote host.

### The cold-start constraint

`updateInfo` only exists on servers new enough to ship it — and the servers
being blocked are, by definition, old. The first generation of blocked servers
will send **no** `updateInfo` at all. The advisor must therefore be fully
functional from client-side data alone: the compat verdict, the already-shipped
`hostPlatform` field on `RuntimeStatus` (`src/shared/runtime-types.ts` — itself
optional; servers older than it land in the unknown-install guide), the
paired endpoint's port, and client-side release metadata. `updateInfo` is an
investment that pays off the *next* time a server falls behind. This also
means steps 1–2 of the rollout should reach a release as early as possible,
independent of the UI.

## Goals

- Show a clear "Update server required" prompt when protocol compatibility
  blocks a paired server, reusing the existing entry points
  (`HostSectionHeaderMenu.tsx`, `RuntimeEnvironmentsPane.tsx`).
- Handle `client-too-old` by routing to the local update flow instead.
- Show running and required protocol versions from the compat verdict.
- Add optional update metadata to runtime status so future blocked states can
  display server version, latest known version, install kind, and restart kind.
- Provide copyable update commands or manual steps for the detected
  platform/arch/install kind, and a useful fallback when unknown.
- Support the SSH use case: the guidance is written to be pasted into the
  user's own SSH session on the server. Orca does not run it.
- Never block the compat gate or the status path on a network call.

## Non-Goals

- Do not run update commands on the remote server, via any transport —
  including SSH connections Orca already holds for SSH workspaces.
- Do not invoke `sudo`, package managers, installers, or service restarts.
- Do not silently replace AppImages or desktop apps.
- Do not require exact app-version equality between client and server
  (protocol versions decide compatibility; app versions are display/advice).
- Do not build a new stateful update service for the MVP.
- Do not cover the SSH relay (`src/main/ssh/ssh-relay-deploy.ts`). The relay
  is client-deployed into content-hash-versioned install dirs and self-heals on
  version mismatch; it never needs this advisor. This doc is about paired
  `orca serve` runtime servers.

## Design

### Trust model

Every `updateInfo` field crosses a trust boundary: it is produced by a remote,
possibly compromised, server and some of it is rendered into commands the user
is invited to paste into a root shell. Rules:

- Command blocks are rendered **only from client-owned templates**. Server
  data may select a template or fill a validated placeholder; it is never
  concatenated into a command as free text.
- `serviceName`: must match `^orca[A-Za-z0-9@:._-]{0,75}\.service$` — the
  mandatory `orca` prefix mirrors the trust rule cgroup-based systemd
  detection already applies ("trusted only when the unit name starts with
  `orca`"), so a compromised server cannot aim the rendered
  `sudo systemctl restart` at an unrelated unit such as `sshd.service`, and
  the leading alphanumeric means the value can never parse as a `systemctl`
  flag. Otherwise it is discarded and the default `orca-serve.service` is
  used.
- `installPath`: must be absolute, end in `.AppImage`, and match
  `^[A-Za-z0-9/._~+-]{1,256}$` (no spaces, quotes, or shell metacharacters) or
  it is discarded and the documented default `/opt/orca/orca-linux.AppImage`
  is used. The `.AppImage` suffix is load-bearing: the template `sudo mv`s
  onto this path, so without it a malicious server could aim the overwrite at
  an arbitrary root-owned file. Only the Linux AppImage template renders
  `<install-path>`; typical Windows paths (drive letters, backslashes) fail
  the regex anyway, and the Windows and macOS guides never embed a path in a
  command.
- `currentVersion` / `latestVersion`: must match
  `^\d+\.\d+\.\d+(-[A-Za-z0-9.-]{1,40})?$` or they are not displayed.
- `docsUrl`: parsed with `new URL()` and rendered only if the origin is
  `https://github.com` and the **parsed** pathname is `/stablyai/orca` or
  starts with `/stablyai/orca/`; otherwise the client's built-in links are
  used. Checking the parsed pathname defeats `…/orca/../other-repo`, which a
  raw string-prefix check passes and browsers normalize to another repo; the
  trailing slash rules out sibling names like `stablyai/orca-foo`.
- Port: taken from the client's own paired endpoint (an integer the client
  already validated), never from server metadata. Behind a tunnel or proxy it
  can differ from the server's listen port, so guides treat it as a hint.
- Enum fields (`installKind`, `restartKind`): unrecognized values are treated
  as `unknown`. `hostArch` is a free-form `process.arch` string: anything
  other than a recognized arch (`x64`, `arm64`) is treated as absent.

Values that fail validation are treated as absent — no error, no partial
rendering.

### Runtime status metadata

Add optional `updateInfo` to `RuntimeStatus`, alongside the existing
`runtimeProtocolVersion` / `capabilities` / `hostPlatform` fields, emitted from
the same place status is stamped today (`src/main/runtime/orca-runtime.ts`).
Older servers omit it; all client handling must be defensive.

Detection is computed **once at server startup and cached** — never on the
status hot path, which is polled. No package-manager subprocess may run per
status request. Signals, in order of reliability:

- `source`: `app.isPackaged` is false.
- `linux-appimage`: `process.env.APPIMAGE` is set (the AppImage runtime sets
  it); its value is `installPath`.
- `windows-installer`: win32 and `process.execPath` under the NSIS install
  location.
- `mac-app`: darwin and `process.execPath` inside a `.app` bundle. Homebrew
  cask installs copy the app into `/Applications`, so `mac-homebrew` is not
  reliably distinguishable at runtime; when ambiguous, report `mac-app` (the
  mac guide includes a Homebrew alternative). `mac-homebrew` stays in the enum
  for explicit future configuration.
- `linux-deb` / `linux-rpm`: non-AppImage packaged Linux install (execPath
  under the package install dir); the deb-vs-rpm distinction may use a single
  package-ownership check at startup. If the check is skipped or fails, report
  `unknown`.
- `restartKind: systemd`: `/proc/self/cgroup` names a `.service` unit under
  `/system.slice/` — which also yields `serviceName`. A user-slice `.service`
  cgroup is trusted only when the unit name starts with `orca`: children share
  their parent's cgroup, so a manual `orca serve` inside a terminal or
  multiplexer that itself runs as a user service (e.g.
  `gnome-terminal-server.service`, a tmux user unit) would otherwise
  false-positive. `INVOCATION_ID` alone is not trusted for the same
  inheritance reason.
- `restartKind: desktop` when serving from the full desktop app;
  `foreground-serve` for `orca serve` with no systemd markers.

Detection must prefer `unknown` over guessing, and prefer the broader kind
over an unverified narrower one.

`hostArch` is `process.arch`, needed because Linux assets differ by arch
(`orca-linux.AppImage` vs `orca-linux-arm64.AppImage`). When absent (old
server), the guide shows the x64 command with an arm64 note rather than
guessing.

### Client prompt surfaces

Use the same advisor content everywhere a blocked remote server surfaces:

- Runtime environment settings row (`RuntimeEnvironmentsPane.tsx`): the
  strongest detail view — versions, detected install/restart kind, copyable
  commands, docs links, and "Check again" (re-fetches status and re-evaluates
  compatibility). "Check again" disables with a spinner while the recheck is
  in flight; on success the blocked state clears back to the normal server
  view, and on continued incompatibility an inline note confirms the server
  is still out of date — never a click with no visible response.
- Sidebar host menu (`HostSectionHeaderMenu.tsx`): keep the existing
  "Update server required" action; deep-link to the settings row.
- Blocked action dialog or toast: the compat gate already throws a
  `RUNTIME_COMPAT_BLOCK_CODE`-tagged error
  (`src/renderer/src/runtime/runtime-protocol-compat.ts`), so surfaces can
  distinguish a version block from a transport failure and offer the same
  deep-link.

The advisor needs the blocked server's `RuntimeStatus` (`hostPlatform`,
`updateInfo`) and the compat verdict even though the gate throws. Today the
`RUNTIME_COMPAT_BLOCK_CODE` error carries only a message and code, discarding
both: attach the verdict and `RuntimeStatus` to that error (e.g.
`error.verdict`, `error.status`), and have "Check again" read status through
the raw non-asserting RPC (`status.get` + `unwrapRuntimeRpcResult`) rather
than `getRuntimeEnvironmentStatus`, so detection and versions can render
while the environment stays blocked.

Primary copy for `server-too-old`:

> This Orca server needs an update before this client can use it.

For `client-too-old`, keep the existing `describeRuntimeCompatBlock` message
and offer the local updater action instead of any server guidance.

When detection is available, include a line such as:

> Detected: Linux AppImage, systemd service.

The line comma-joins only the fields that resolved — e.g. "Detected: Linux
AppImage" when `restartKind` is `unknown` — and is omitted entirely when both
are unknown.

Command blocks are copyable one block at a time. A command block is a
suggestion for the user to run on the server (typically over their own SSH
session), never a command Orca executes.

The mobile client duplicates the compat evaluators (see the header comment in
`protocol-compat.ts`); the guide matrix and copy should live in shared,
dependency-free modules so mobile can mirror them.

### Update guide matrix

The client owns a guide matrix keyed by `hostPlatform`, `hostArch`,
`installKind`, and `restartKind`. It ships with the client and needs no server
deploy to change. Placeholders below (`<install-path>`, `<service-name>`,
`<port>`) are filled from validated metadata or documented defaults
(`/opt/orca/orca-linux.AppImage`, `orca-serve.service`, `6768` — matching
`docs/reference/headless-linux-server.md`).

All Linux download commands write to a sibling temp file and `mv` into place.
Overwriting a running binary in place fails with `ETXTBSY`; `mv` within the
same directory is an atomic rename that works while the old version runs. Do
not stage in `/tmp` — a cross-filesystem `mv` degrades to a non-atomic copy
into the destination path, which reintroduces the same failure.

Linux AppImage (x64; use `orca-linux-arm64.AppImage` on arm64), download and
swap:

```bash
sudo curl -fL https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \
  -o <install-path>.new
sudo chmod +x <install-path>.new
sudo mv <install-path>.new <install-path>
```

Then restart:

- systemd service: `sudo systemctl restart <service-name>`
- foreground server: stop the running `orca serve` (Ctrl+C) and re-run your
  usual serve command, e.g.
  `LIBGL_ALWAYS_SOFTWARE=1 <install-path> serve --port <port>` plus any flags
  you normally pass (such as `--pairing-address`). The advisor cannot know the
  original command line, so it must not present an invented one as complete.

Debian or Ubuntu package (assets are versioned: `orca-ide_<version>_amd64.deb`,
or `_arm64.deb` on arm64; when release metadata supplies the exact asset URL
the advisor prepends a matching `curl -fLO <asset-url>` line — here and for
rpm — otherwise it links the releases page and the command uses the downloaded
filename):

```bash
curl -fLO <asset-url>   # included when release metadata supplies the exact asset URL
sudo apt install ./orca-ide_<version>_amd64.deb
sudo systemctl restart <service-name>   # if running as a service
```

Fedora, RHEL, or compatible RPM package (`orca-ide-<version>.x86_64.rpm` /
`.aarch64.rpm`):

```bash
curl -fLO <asset-url>   # included when release metadata supplies the exact asset URL
sudo dnf install ./orca-ide-<version>.x86_64.rpm
sudo systemctl restart <service-name>   # if running as a service
```

macOS desktop app:

- Open Orca on that Mac and use the in-app update flow, or download the latest
  `orca-macos-<arch>.dmg` from the releases page and replace the app.
- If it was installed with Homebrew: `brew update && brew upgrade --cask
  stablyai/orca/orca --greedy` (the cask is marked `auto_updates`, so plain
  `brew upgrade` skips it; `--greedy` is required).
- Restart the paired server after the app updates.

Windows installer:

- Open Orca on that Windows machine and use the in-app update flow, or
  download and run
  `https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe`.
- Restart Orca (or the `orca serve` process) after installation.

Source build: pull and rebuild; link the repo README.

Unknown install:

- Show the server platform and version if known.
- Link `docs/reference/headless-linux-server.md` (on GitHub) and the releases
  page.
- Tell the user to update Orca on the server machine, restart the server, and
  click "Check again".

Exact deb/rpm filenames are versioned and must come from release metadata. If
the client does not know the exact asset URL, it shows manual download
guidance — it never invents a versioned filename. The unversioned
`releases/latest/download/` URLs are stable only for the artifacts with
unversioned names in `config/electron-builder.config.cjs`:
`orca-linux.AppImage`, `orca-linux-arm64.AppImage`, `orca-macos-<arch>.dmg`,
and `orca-windows-setup.exe`.

### Release metadata

No new update service. The desktop updater already publishes electron-updater
manifests at a stable generic feed
(`https://github.com/stablyai/orca/releases/latest/download` — see
`src/main/updater.ts`): `latest-linux.yml`, `latest-mac.yml`, and `latest.yml`
carry the latest version and asset filenames (the arm64 Linux release
publishes its own `latest-linux-arm64.yml` variant). The advisor picks the
manifest matching the *server's* platform/arch — not the client's — and reuses
it for `latestVersion` / `updateAvailable` / exact asset names.

Constraints, all inherited from known updater behavior:

- The fetch is best-effort with a short timeout, done lazily when the advisor
  is shown — never on the compat gate or status path. Failure means
  `updateAvailable: null` and version-less guidance, not an error.
- During release transitions, GitHub can expose a release before its assets
  are reachable (see the walk-back logic in `updater.ts`). A fetched manifest
  that names unreachable assets must degrade to the manual releases-page link,
  not a broken copyable URL.
- Results may be cached briefly on the client; staleness only affects advice
  text, never compatibility.
- If a server ever populates `latestVersion` / `updateAvailable` itself (e.g.
  from its own updater check at startup), the client-fetched manifest wins:
  server values are startup-stale hints and are never refreshed on the status
  path.

A stateful update service is only needed later for staged rollouts, kill
switches, signed org policy, private channels, or fleet controls.

## Rollout

Ordered so each piece is independently safe; one PR works, but steps 1–2 may
land earlier on their own (see the cold-start constraint):

1. `RuntimeUpdateInfo` type in `src/shared/runtime-types.ts`; startup-cached
   detection in main; emit `updateInfo` in runtime status
   (`src/main/runtime/orca-runtime.ts`).
2. Validation module for server-supplied fields (shared, dependency-free, unit
   tested against injection inputs).
3. Client-side guide matrix keyed by platform/arch/installKind/restartKind
   with the fallback chain above (shared module for mobile reuse).
4. Advisor UI in `RuntimeEnvironmentsPane.tsx` with both verdict directions:
   `server-too-old` → guidance; `client-too-old` → local updater action.
   "Check again" re-fetches status.
5. Deep-links from `HostSectionHeaderMenu.tsx` ("Update server required") and
   from `RUNTIME_COMPAT_BLOCK_CODE` error surfaces.
6. Lazy release-metadata lookup (`latest-*.yml`) for `latestVersion`,
   `updateAvailable`, and exact deb/rpm asset names.

## Testing

- Unit: detection mapping per platform fixture (APPIMAGE env, systemd cgroup
  line — including a user-slice terminal-service cgroup that must not map to
  `systemd`, `app.isPackaged`); every validation regex rejects
  shell-metacharacter payloads (`; curl … | sh`, backticks, `$()`, newlines) and accepts the
  documented defaults.
- Unit: guide matrix snapshot per (platform, arch, installKind, restartKind)
  key plus the all-fields-absent cold-start case — the doc's own commands are
  the expected output.
- Unit: verdict branching — `client-too-old` never renders server commands.
- Extend `runtime-compatibility-test-fixture.ts` (today it only builds
  compatible-status responses) with blocked-status fixtures with and without
  `updateInfo`.
- Manifest fetch: timeout and 404 paths yield `updateAvailable: null` and the
  fallback guide; no path throws into the compat gate.

## Alternatives Considered

### Full remote self-update

The client could download an asset on the remote machine, install it, and
restart the server — including over an SSH connection Orca already holds for
SSH workspaces.

Rejected for the first version. Remote hosts vary too much: AppImages, systemd
services, desktop apps, Windows installers, package managers, and source
builds all have different permission and restart models. Running install
commands remotely — even over Orca-owned SSH — creates a trust and audit
problem, especially when `sudo` or service restarts are involved. It can be
revisited as an explicit, capability-gated flow that asks for confirmation and
shows exactly what will run.

### Protocol-only error message

Keep the current compatibility block and only say the server is too old.

Rejected. Technically safe but not user-safe: the user still has to infer
which machine is stale, how Orca was installed there, which asset to download,
and whether a service restart is needed.

### Client-only latest-version check

Compare the remote protocol against the client's own app version or update
feed, with no server metadata.

Rejected as the only mechanism. The client's platform and install channel need
not match the server's — a macOS client may pair with a Linux AppImage server.
Client-side release data feeds the guides, but cannot describe the server's
install shape.

### Require a new Orca update server

Rejected for the MVP. The advisor needs best-effort latest-version and asset
metadata, which the existing electron-updater manifests already provide.

### Exact version lockstep

Require the server to run the exact client app version.

Rejected. The protocol contract in `protocol-compat.ts` already defines
compatibility, and exact equality would fail compatible pairs. App versions
are for display and advice only.

## Deferred / Open Questions

### From 2026-07-06 review

- **Blocked surface left undecided between dialog and toast** — Client prompt surfaces (P1, design-lens, confidence 75)

  Dialog and toast are not interchangeable: a dialog is modal, traps focus,
  and requires explicit dismissal, while a toast is transient, non-blocking,
  and typically announced as a polite live region. The doc says "Blocked
  action dialog or toast" without choosing, leaving the implementer to pick
  focus-management and dismissal behavior on their own, risking inconsistent
  UX if this surface and future blocked-action surfaces land differently.

- **Advisor assumes the blocked user can run sudo on the server** — Goals / Client prompt surfaces (P2, product-lens, adversarial, confidence 75)

  Every actionable path the advisor produces is a sudo command pasted into
  the user's own SSH session, which assumes the blocked user is also the
  server's administrator. On shared or team-administered servers the
  copyable commands are un-runnable and the block stays exactly as
  unactionable as the plain "update the server" message. A copyable "send
  these steps to whoever administers this server" handoff would keep the
  goal met for non-admin users.

- **Server-metadata pipeline is sequenced first but delivers no value to currently-blocked servers** — Rollout / cold-start constraint (P2, product-lens, adversarial, confidence 75)

  By the doc's own logic, rollout steps 1–2 (updateInfo schema, cached
  detection, trust model) help no server blocked today — they pay off only
  the next time a server falls behind, and that window's population is
  unvalidated. The client-only advisor (steps 3–5) already delivers the full
  user-facing unblock; consider shipping it as v1 and treating steps 1–2 and
  6 as a fast-follow once advisor engagement is confirmed, or naming the
  expected frequency of the payoff window to justify front-loading a
  permanent wire contract.
