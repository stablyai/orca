# Headless Linux Server

Use this guide when you want to run `orca serve` on a Linux machine without a
desktop session, such as an Ubuntu VPS or a remote build box.

`orca serve` starts the Orca runtime without opening the desktop window. On
Linux, the packaged AppImage still needs the libraries that Electron expects at
startup. Current Orca builds start Xvfb automatically for `orca serve` when no
`DISPLAY` is set, but Xvfb must be installed first. A separate D-Bus session is
not required. When `DISPLAY` is set, Orca uses that display instead of starting
a competing Xvfb process.

The supported deployment matrix covers Ubuntu 20.04, 22.04, and 24.04 and
current Debian stable — anything with glibc 2.31 or newer (see
[Linux glibc compatibility](./linux-glibc-compatibility.md)). Package names can
differ on other Debian-derived releases.

## Ubuntu and Debian prerequisites

Install the AppImage runtime dependency and Xvfb:

```bash
sudo apt-get update
sudo apt-get install -y curl file jq xvfb zlib1g-dev
```

On Ubuntu 22.04, install `libfuse2` to execute the AppImage through FUSE. On
Ubuntu 24.04 and Debian, the equivalent package may be `libfuse2t64`. FUSE is
optional: without it, use the AppImage's supported extraction path:

```bash
cd /opt/orca
./orca-linux.AppImage --appimage-extract
/opt/orca/squashfs-root/AppRun serve --port 6768
```

Docker commonly has no FUSE device. Use `--appimage-extract` once or
`--appimage-extract-and-run`; neither requires a privileged container. The
extract-and-run wrapper can print extracted paths before Orca starts, so
automation that requires stdout to contain only the ready JSON should extract
once and invoke `squashfs-root/AppRun`.

Download and make the AppImage executable:

```bash
sudo mkdir -p /opt/orca
sudo curl -L https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \
  -o /opt/orca/orca-linux.AppImage
sudo chmod +x /opt/orca/orca-linux.AppImage
```

If `Xvfb` was installed somewhere other than `/usr/bin`, confirm systemd can
find it later:

```bash
command -v Xvfb
```

## Run In The Foreground

Start with a foreground run before creating a service:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve --port 6768
```

For remote clients, pass the address they should use to reach this server. A
Tailscale address is usually the safest option for private servers:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve \
  --port 6768 \
  --pairing-address 100.64.1.20
```

`--pairing-address` is only the address advertised to clients. It does not
change the listener bind address. Orca binds its WebSocket listener, then
combines the actual bound port with the advertised host when the address omits
a port. Use a reachable LAN/Tailscale hostname or IP, or a complete reverse
proxy URL such as `https://orca.example.com/runtime` (`http(s)` is normalized
to `ws(s)`). Wildcard addresses such as `*`, `0.0.0.0`, and `::` cannot be
advertised.

The command writes one ready block to stdout after the listener bind and
pairing initialization complete:

```text
Orca server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://100.64.1.20:6768
Pairing URL: orca://pair?code=...
```

For supervisors, request the versioned single-line JSON contract:

```bash
/opt/orca/orca-linux.AppImage serve --port 6768 \
  --pairing-address 100.64.1.20 --json
```

The actual output is one compact line; this example is pretty-printed for
readability:

```json
{
  "type": "orca_server_ready",
  "schemaVersion": 1,
  "runtimeId": "...",
  "endpoint": "ws://0.0.0.0:6768",
  "boundEndpoint": "ws://0.0.0.0:6768",
  "advertisedEndpoint": "ws://100.64.1.20:6768",
  "managedWslCliReconciliation": "settled",
  "pairing": {
    "available": true,
    "url": "orca://pair?code=...",
    "endpoint": "ws://100.64.1.20:6768",
    "deviceId": "...",
    "webClientUrl": "...",
    "scope": "runtime",
    "qr": null
  }
}
```

`endpoint` remains a compatibility alias for `boundEndpoint`; new automation
should use the explicit bound and advertised fields.

When the server remains usable but cannot mint an offer, `pairing` remains an
object with `available:false`, a stable `reason`, and operator `guidance`; it is
never silently omitted. `--recipe-json` is stricter and exits with that reason
because its contract requires a pairing URL. Stop a foreground server with
`Ctrl+C`. Stable reasons are `disabled_by_operator`, `websocket_unavailable`,
`device_registry_unavailable`, `e2ee_key_unavailable`, and
`invalid_advertised_endpoint`.

## Systemd Service

Create a dedicated service user and install directory. Run the service as this
user instead of root so the AppImage can keep Chromium's sandbox enabled. Keep
the install directory root-owned: the service needs to read and execute the
AppImage, but must not be able to replace it or the rollback artifacts.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin orca
sudo chown root:root /opt/orca /opt/orca/orca-linux.AppImage
sudo chmod 755 /opt/orca /opt/orca/orca-linux.AppImage
```

For most hosts, one `orca serve` service is enough because Orca starts Xvfb on
display `:99` when no display exists:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that
clients should use.

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
sudo journalctl -u orca-serve.service -f
```

`journalctl -o cat` removes journal metadata but still mixes the service's
stdout and stderr. Parse each line as JSON and require the readiness type and
schema before treating the service as ready:

```bash
sudo journalctl -u orca-serve.service -o cat \
  | jq -Rrc 'fromjson? | select(.type == "orca_server_ready" and .schemaVersion == 1)'
```

A bounded health check should require that contract within its startup timeout;
otherwise inspect earlier diagnostics for the precise pairing reason, listener
error, or missing library.

## Managed Xvfb Service

If you prefer to own the virtual display lifecycle in systemd, run Xvfb as a
separate service and set `DISPLAY=:99` for Orca.

```ini
# /etc/systemd/system/orca-xvfb.service
[Unit]
Description=Virtual X display for Orca
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `command -v Xvfb` returned a different path, update `ExecStart` to that
absolute path.

Then add the display dependency to the Orca service:

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca runtime server
After=network-online.target orca-xvfb.service
Wants=network-online.target orca-xvfb.service

[Service]
Type=simple
User=orca
WorkingDirectory=/home/orca
Environment=DISPLAY=:99
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/orca/orca-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable both units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-xvfb.service orca-serve.service
```

## CLI Install Note

On a headless host, you do not need to open the desktop UI just to run the
server. Invoke the AppImage directly:

```bash
/opt/orca/orca-linux.AppImage serve --help
```

Running an AppImage as root requires Chromium's `--no-sandbox` switch before
the command:

```bash
/opt/orca/orca-linux.AppImage --no-sandbox serve --port 6768
```

This disables a security boundary. Prefer a dedicated unprivileged service
user, especially when the listener is reachable beyond localhost.

## Pairing troubleshooting

- A pairing offer is a capability containing a device credential and E2EE
  material. Share it only with the intended client and do not put it in proxy
  access logs.
- `boundEndpoint` is where the process listens; `advertisedEndpoint` is what a
  client dials. A valid-looking offer still cannot connect if DNS, firewall,
  Docker port publishing, Tailscale policy, or a reverse proxy does not route
  the advertised endpoint to the bound port.
- An omitted advertised port uses the actual bound port, including a fallback
  port selected after a collision. An explicit proxy port is preserved. A port
  mismatch therefore means the supplied external routing is wrong, not that
  Orca changes it.
- Reverse proxies must support WebSocket upgrade and route the advertised path.
  Use `wss://` or `https://` when TLS terminates at the proxy; do not advertise
  `ws://` through an HTTPS-only endpoint.
- Hostnames, IPv4, bracketed IPv6, and raw IPv6 literals are supported. IPv6
  still requires an IPv6-reachable listener/network path.
- `xvfb-run` and `dbus-run-session -- xvfb-run` remain valid diagnostic launch
  shapes, but neither should be needed when `Xvfb` is installed and no display
  is configured. Repeated D-Bus messages without a ready block indicate startup
  did not reach serve mode; confirm the AppImage version and exact argument
  order, especially `--no-sandbox serve`.

If you later install the desktop CLI from Orca settings, use that CLI for normal
shell workflows. Keep the AppImage path in systemd so service restarts do not
depend on an interactive shell profile.

## Upgrade

`orca serve` never updates itself. In headless mode Orca wires up no auto-updater
at all — the built-in updater only runs in the desktop GUI, and no paired mobile
or web client can trigger it remotely. Upgrading is always a deliberate step:
replace the AppImage and restart the service.

Two facts make this safe and predictable:

- **State lives in the service user's home, not next to the binary.** Persisted
  data is under `/home/orca/.config/` (Orca uses both an `orca` and an `Orca`
  directory there), fully independent of `/opt/orca/orca-linux.AppImage`.
  Replacing the binary never touches projects, worktree metadata, terminal
  history, orchestration state, or paired-device keys — so mobile and web
  clients reconnect after an upgrade without re-pairing.
- **New builds migrate old state on load.** Orca loads older `orca-data.json`
  state into the current schema and writes it back in the current shape, so a
  forward upgrade needs no manual data step.

Rolling back is the case that needs care — see [Roll back](#roll-back).

### Record the version you deploy

Orca has no headless version command: there is no `--version` flag or `version`
subcommand, and `orca serve` prints only its endpoint. Choose a release tag
explicitly instead of following the `latest` URL, and record it next to the
binary so upgrades are auditable. The steps below keep that record in
`/opt/orca/VERSION`.

### Upgrade steps

Never download straight onto `/opt/orca/orca-linux.AppImage`. The AppImage is
FUSE-mounted, so overwriting it in place while the service runs can crash or
corrupt the live process — and even with the service stopped, a failed or partial
download would clobber the working binary. Instead download to a temporary name
on the same filesystem, verify it, then swap it in with an atomic rename.

Check capacity before starting:

```bash
sudo chown root:root /opt/orca
sudo chmod 755 /opt/orca
sudo test ! -L /opt/orca/orca-linux.AppImage
sudo chown root:root /opt/orca/orca-linux.AppImage
sudo chmod 755 /opt/orca/orca-linux.AppImage
# Clear predictable staging names left by an older attempt after locking the directory
sudo rm -f /opt/orca/orca-linux.AppImage.new /opt/orca/VERSION.new \
  /opt/orca/orca-linux.AppImage.recovering /opt/orca/VERSION.recovering
sudo du -sh /home/orca/.config
df -h /opt/orca /home/orca
```

`/opt/orca` needs room for the compressed Orca profile archive, the staged
build, and the rollback binary. A rollback extracts the old profile and preserves
the post-upgrade Orca profile directories, so `/home` needs room for both copies.

Run the following block as one Bash script so its fail-fast and recovery traps
remain active for the whole operation:

```bash
set -euo pipefail

# Replace this example with the release tag you intend to deploy
ORCA_VERSION=v1.4.147

# Select the release asset on the server where Orca runs
case "$(uname -m)" in
  x86_64)
    ORCA_ASSET=orca-linux.AppImage
    ORCA_FILE_MACHINE=x86-64
    ;;
  aarch64 | arm64)
    ORCA_ASSET=orca-linux-arm64.AppImage
    ORCA_FILE_MACHINE='ARM aarch64'
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

ORCA_ROLLBACK_NEW=
ORCA_ROLLBACK=
ORCA_SERVICE_STOPPED=0
ORCA_BINARY_PROMOTED=0
recover_failed_upgrade() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0)); then
    sudo rm -f /opt/orca/orca-linux.AppImage.new /opt/orca/VERSION.new \
      /opt/orca/orca-linux.AppImage.recovering /opt/orca/VERSION.recovering
  fi
  if ((exit_status != 0)) && [[ -n "$ORCA_ROLLBACK_NEW" ]] && \
    sudo test -d "$ORCA_ROLLBACK_NEW"; then
    sudo rm -rf -- "$ORCA_ROLLBACK_NEW"
  fi
  if ((exit_status != 0 && ORCA_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((ORCA_BINARY_PROMOTED)); then
      if ! sudo cp -a "$ORCA_ROLLBACK/orca-linux.AppImage" \
        /opt/orca/orca-linux.AppImage.recovering || \
        ! sudo mv -f /opt/orca/orca-linux.AppImage.recovering \
          /opt/orca/orca-linux.AppImage; then
        recovery_ok=0
      fi
      if sudo test -f "$ORCA_ROLLBACK/VERSION"; then
        if ! sudo cp -a "$ORCA_ROLLBACK/VERSION" /opt/orca/VERSION.recovering || \
          ! sudo mv -f /opt/orca/VERSION.recovering /opt/orca/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo rm -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    fi
    sudo rm -f /opt/orca/orca-linux.AppImage.recovering \
      /opt/orca/VERSION.recovering
    if ((recovery_ok)); then
      sudo systemctl start orca-serve.service || true
    else
      echo 'Upgrade recovery failed; service remains stopped' >&2
    fi
  fi
  exit "$exit_status"
}
trap recover_failed_upgrade EXIT

# 1. Stage and verify the new build while the server stays online
sudo curl -fL --retry 3 "https://github.com/stablyai/orca/releases/download/${ORCA_VERSION}/${ORCA_ASSET}" \
  -o /opt/orca/orca-linux.AppImage.new
sudo chown root:root /opt/orca/orca-linux.AppImage.new
sudo chmod 755 /opt/orca/orca-linux.AppImage.new

# Both checks must match; either grep stops this fail-fast block otherwise
ORCA_FILE_INFO=$(LC_ALL=C file /opt/orca/orca-linux.AppImage.new)
grep 'ELF .* executable' <<<"$ORCA_FILE_INFO"
grep -F "$ORCA_FILE_MACHINE" <<<"$ORCA_FILE_INFO"

# 2. Assemble the prior binary and version in a root-only rollback bundle
ORCA_ROLLBACK_BASE=/opt/orca/orca-rollback-$(date +%F-%H%M%S-%N)
ORCA_ROLLBACK_NEW=${ORCA_ROLLBACK_BASE}.new
ORCA_ROLLBACK=${ORCA_ROLLBACK_BASE}.ready
sudo install -d -m 700 "$ORCA_ROLLBACK_NEW"
sudo cp -a /opt/orca/orca-linux.AppImage "$ORCA_ROLLBACK_NEW/orca-linux.AppImage"
if sudo test -f /opt/orca/VERSION; then
  sudo cp -a /opt/orca/VERSION "$ORCA_ROLLBACK_NEW/VERSION"
fi

# Stage the new version record before the stop window
printf '%s\n' "$ORCA_VERSION" | sudo tee /opt/orca/VERSION.new >/dev/null
sudo chown root:root /opt/orca/VERSION.new
sudo chmod 644 /opt/orca/VERSION.new

# 3. Stop the server so the profile backup is consistent
ORCA_SERVICE_STOPPED=1
sudo systemctl stop orca-serve.service

# Add only Orca-owned profile directories, then publish the complete bundle
ORCA_PROFILE_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "/home/orca/.config/$profile_dir"; then
    echo "Refusing symlinked Orca profile: /home/orca/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/orca/.config/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test /home/orca/.config/orca -ef /home/orca/.config/Orca; then
      continue
    fi
    ORCA_PROFILE_DIRS+=("$profile_dir")
  fi
done
if ((${#ORCA_PROFILE_DIRS[@]} == 0)); then
  echo 'No Orca profile directory found under /home/orca/.config' >&2
  exit 1
fi
sudo tar czf "$ORCA_ROLLBACK_NEW/profile.tgz" \
  -C /home/orca/.config "${ORCA_PROFILE_DIRS[@]}"
sudo chmod 600 "$ORCA_ROLLBACK_NEW/profile.tgz"
sudo mv "$ORCA_ROLLBACK_NEW" "$ORCA_ROLLBACK"

# 4. Atomically replace the binary and version record, then start
ORCA_BINARY_PROMOTED=1
sudo mv -f /opt/orca/orca-linux.AppImage.new /opt/orca/orca-linux.AppImage
sudo mv -f /opt/orca/VERSION.new /opt/orca/VERSION
sudo systemctl start orca-serve.service
ORCA_SERVICE_STOPPED=0
trap - EXIT
```

The profile archive created in step 3 captures both Orca profile directory names
when present without rewinding unrelated tools under `/home/orca/.config`. The
`.ready` suffix is published only after the prior binary, version record, and
profile archive are complete. If you run the managed Xvfb unit, only
`orca-serve.service` needs restarting — leave `orca-xvfb.service` running.

### Verify

```bash
sudo journalctl -u orca-serve.service -f
```

A healthy start prints one `Orca server ready` block with the actual bound and
advertised endpoints. Verify those values rather than assuming the configured
port, because a collision can select a fallback port.
Confirm a client reconnects before you discard the backup. The timestamped
rollback bundles are not pruned automatically. After the new version satisfies
your retention policy, select and inspect the newest complete bundle before
removing it:

```bash
shopt -s nullglob
ORCA_ROLLBACK_SETS=(/opt/orca/orca-rollback-*.ready)
((${#ORCA_ROLLBACK_SETS[@]} > 0))
ORCA_ROLLBACK=${ORCA_ROLLBACK_SETS[${#ORCA_ROLLBACK_SETS[@]} - 1]}
printf 'Removing rollback bundle: %s\n' "$ORCA_ROLLBACK"
sudo test -d "$ORCA_ROLLBACK"
sudo rm -rf -- "$ORCA_ROLLBACK"
```

Each `.ready` directory is a self-contained rollback generation; never combine
files from different bundles.

### Roll back

A rollback is **not** binary-only safe. Once a newer build has started, it can
rewrite `orca-data.json` in the current schema. If an older build then writes
that file, it can discard fields it does not recognize. The rolling
`orca-data.json.bak.*` files are corruption-recovery snapshots, not a dedicated
pre-upgrade copy, and normal writes can rotate them away. To roll back cleanly,
restore the backup from step 3 **and** swap the binary back. Run this block as one
Bash script:

```bash
set -euo pipefail

# Select and validate one complete generation before taking the service offline
shopt -s nullglob
ORCA_ROLLBACK_SETS=(/opt/orca/orca-rollback-*.ready)
((${#ORCA_ROLLBACK_SETS[@]} > 0))
ORCA_ROLLBACK=${ORCA_ROLLBACK_SETS[${#ORCA_ROLLBACK_SETS[@]} - 1]}
sudo test -f "$ORCA_ROLLBACK/orca-linux.AppImage"
sudo tar tzf "$ORCA_ROLLBACK/profile.tgz" >/dev/null

# Extract and validate the old profile while the current server stays online
sudo test ! -L /home
ORCA_HOME_OWNER=$(sudo stat -c %u /home)
ORCA_HOME_MODE=$(sudo stat -c %a /home)
if [[ "$ORCA_HOME_OWNER" != 0 ]] || ((8#$ORCA_HOME_MODE & 0022)) || \
  sudo -u orca test -w /home; then
  echo 'Refusing rollback because /home is not root-controlled' >&2
  exit 1
fi
ORCA_RESTORE=$(sudo mktemp -d /home/.orca-restore.XXXXXX)
ORCA_SERVICE_STOPPED=0
ORCA_MOVED_CURRENT_DIRS=()
ORCA_INSTALLED_RESTORE_DIRS=()
ORCA_CURRENT_BINARY_MOVED=0
ORCA_CURRENT_VERSION_MOVED=0
ORCA_VERSION_REPLACEMENT_STARTED=0
ORCA_POST_UPGRADE=
ORCA_ROLLBACK_BINARY_STAGED=
ORCA_ROLLBACK_VERSION_STAGED=
ORCA_ROLLBACK_HAS_VERSION=0
restart_after_rollback_error() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0 && ORCA_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((${#ORCA_INSTALLED_RESTORE_DIRS[@]})); then
      for profile_dir in "${ORCA_INSTALLED_RESTORE_DIRS[@]}"; do
        if sudo test -d "/home/orca/.config/$profile_dir"; then
          if ! sudo mv "/home/orca/.config/$profile_dir" \
            "$ORCA_RESTORE/$profile_dir.failed"; then
            recovery_ok=0
          fi
        fi
      done
    fi
    if ((${#ORCA_MOVED_CURRENT_DIRS[@]})); then
      for profile_dir in "${ORCA_MOVED_CURRENT_DIRS[@]}"; do
        if sudo test -d "$ORCA_POST_UPGRADE/$profile_dir"; then
          if ! sudo mv "$ORCA_POST_UPGRADE/$profile_dir" /home/orca/.config/; then
            recovery_ok=0
          fi
        elif ! sudo test -d "/home/orca/.config/$profile_dir"; then
          recovery_ok=0
        fi
      done
    fi
    if [[ -n "$ORCA_POST_UPGRADE" ]]; then
      sudo rmdir "$ORCA_POST_UPGRADE" 2>/dev/null || true
    fi
    if ((ORCA_CURRENT_BINARY_MOVED)); then
      if sudo test -f "$ORCA_CURRENT_BINARY"; then
        if ! sudo mv -f "$ORCA_CURRENT_BINARY" /opt/orca/orca-linux.AppImage; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/orca/orca-linux.AppImage; then
        recovery_ok=0
      fi
    fi
    if ((ORCA_CURRENT_VERSION_MOVED)); then
      if sudo test -f "$ORCA_CURRENT_VERSION"; then
        if ! sudo mv -f "$ORCA_CURRENT_VERSION" /opt/orca/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    elif ((ORCA_VERSION_REPLACEMENT_STARTED)); then
      if ! sudo rm -f /opt/orca/VERSION; then
        recovery_ok=0
      fi
    fi
    if ((recovery_ok)); then
      sudo systemctl start orca-serve.service || true
    else
      echo 'Rollback recovery failed; service remains stopped' >&2
    fi
  fi
  if [[ -n "$ORCA_ROLLBACK_BINARY_STAGED" ]]; then
    sudo rm -f -- "$ORCA_ROLLBACK_BINARY_STAGED"
  fi
  if [[ -n "$ORCA_ROLLBACK_VERSION_STAGED" ]]; then
    sudo rm -f -- "$ORCA_ROLLBACK_VERSION_STAGED"
  fi
  sudo rm -rf -- "$ORCA_RESTORE"
  exit "$exit_status"
}
trap restart_after_rollback_error EXIT

if [[ "$(sudo stat -c %d "$ORCA_RESTORE")" != \
  "$(sudo stat -c %d /home/orca/.config)" ]]; then
  echo 'Refusing rollback because staging and the Orca profile are on different filesystems' >&2
  exit 1
fi
sudo tar xzf "$ORCA_ROLLBACK/profile.tgz" -C "$ORCA_RESTORE"
ORCA_RESTORE_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "$ORCA_RESTORE/$profile_dir"; then
    echo "Rollback bundle contains a symlinked profile: $profile_dir" >&2
    exit 1
  fi
  if sudo test -d "$ORCA_RESTORE/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test "$ORCA_RESTORE/orca" -ef "$ORCA_RESTORE/Orca"; then
      continue
    fi
    ORCA_RESTORE_DIRS+=("$profile_dir")
  fi
done
if ((${#ORCA_RESTORE_DIRS[@]} == 0)); then
  echo "Rollback bundle has no Orca profile directories: $ORCA_ROLLBACK" >&2
  exit 1
fi
for profile_dir in "${ORCA_RESTORE_DIRS[@]}"; do
  sudo chown -R orca:orca "$ORCA_RESTORE/$profile_dir"
done

ORCA_ROLLBACK_STAMP=$(date +%F-%H%M%S-%N)
ORCA_ROLLBACK_BINARY_STAGED=/opt/orca/orca-linux.AppImage.rollback-staged-$ORCA_ROLLBACK_STAMP
sudo cp -a "$ORCA_ROLLBACK/orca-linux.AppImage" "$ORCA_ROLLBACK_BINARY_STAGED"
if sudo test -f "$ORCA_ROLLBACK/VERSION"; then
  ORCA_ROLLBACK_HAS_VERSION=1
  ORCA_ROLLBACK_VERSION_STAGED=/opt/orca/VERSION.rollback-staged-$ORCA_ROLLBACK_STAMP
  sudo cp -a "$ORCA_ROLLBACK/VERSION" "$ORCA_ROLLBACK_VERSION_STAGED"
fi

ORCA_SERVICE_STOPPED=1
sudo systemctl stop orca-serve.service

# Preserve and replace only Orca-owned profile directories
ORCA_CURRENT_DIRS=()
for profile_dir in orca Orca; do
  if sudo test -L "/home/orca/.config/$profile_dir"; then
    echo "Refusing symlinked Orca profile: /home/orca/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/orca/.config/$profile_dir"; then
    if [[ "$profile_dir" == Orca ]] && \
      sudo test /home/orca/.config/orca -ef /home/orca/.config/Orca; then
      continue
    fi
    ORCA_CURRENT_DIRS+=("$profile_dir")
  fi
done
ORCA_POST_UPGRADE=/home/orca/.config/orca-rollback-$ORCA_ROLLBACK_STAMP
sudo install -d -o orca -g orca -m 700 "$ORCA_POST_UPGRADE"
if ((${#ORCA_CURRENT_DIRS[@]})); then
  for profile_dir in "${ORCA_CURRENT_DIRS[@]}"; do
    ORCA_MOVED_CURRENT_DIRS+=("$profile_dir")
    sudo mv "/home/orca/.config/$profile_dir" "$ORCA_POST_UPGRADE/"
  done
fi
for profile_dir in "${ORCA_RESTORE_DIRS[@]}"; do
  ORCA_INSTALLED_RESTORE_DIRS+=("$profile_dir")
  sudo mv "$ORCA_RESTORE/$profile_dir" /home/orca/.config/
done

ORCA_CURRENT_BINARY=/opt/orca/orca-linux.AppImage.rollback-current-$ORCA_ROLLBACK_STAMP
ORCA_CURRENT_BINARY_MOVED=1
sudo mv /opt/orca/orca-linux.AppImage "$ORCA_CURRENT_BINARY"
sudo mv -f "$ORCA_ROLLBACK_BINARY_STAGED" /opt/orca/orca-linux.AppImage

ORCA_CURRENT_VERSION=/opt/orca/VERSION.rollback-current-$ORCA_ROLLBACK_STAMP
if sudo test -f /opt/orca/VERSION; then
  ORCA_CURRENT_VERSION_MOVED=1
  sudo mv /opt/orca/VERSION "$ORCA_CURRENT_VERSION"
fi
ORCA_VERSION_REPLACEMENT_STARTED=1
if ((ORCA_ROLLBACK_HAS_VERSION)); then
  sudo mv -f "$ORCA_ROLLBACK_VERSION_STAGED" /opt/orca/VERSION
else
  sudo rm -f /opt/orca/VERSION
fi
sudo systemctl start orca-serve.service
ORCA_SERVICE_STOPPED=0
sudo rm -rf -- "$ORCA_RESTORE"
trap - EXIT
```

Restoring the backup is required, not optional: swapping only the binary leaves
the newer `orca-data.json` in place, where an older build can discard state it
does not understand. Keep the pre-upgrade backup until the new version is proven
on your host. The `orca-rollback-*` directory inside `.config` is also retained
deliberately. The post-upgrade binary and version record are retained in
`/opt/orca` with the same `rollback-current-<timestamp>` suffix. Inspect these
artifacts and remove them according to your retention policy after the rollback
is resolved.

## Troubleshooting

- `dlopen(): error loading libfuse.so.2`: install `libfuse2`.
- `Missing X server or $DISPLAY`: install `xvfb`, or start the managed Xvfb
  service and set `DISPLAY=:99`.
- `Xvfb not found`: confirm `command -v Xvfb` and use that absolute path in the
  systemd unit.
- GPU or DRI warnings on a VPS: keep `LIBGL_ALWAYS_SOFTWARE=1` in the service
  environment.
- Chromium sandbox errors: confirm the service is running as the non-root
  `orca` user and that `/opt/orca` is readable by that user.
- Clients cannot connect: make sure `--pairing-address` is an address reachable
  from the client, and make sure firewalls allow the selected `--port`.
- Service crash-loops right after an upgrade: use [Roll back](#roll-back) with
  the pre-upgrade `.ready` bundle. Do not rerun the upgrade first; doing so would
  make the crashing version the next rollback binary.
- Diagnosing other missing libraries: extract the AppImage without launching it
  with `./orca-linux.AppImage --appimage-extract`, then run
  `ldd squashfs-root/orca` to list any shared libraries the host is missing.
