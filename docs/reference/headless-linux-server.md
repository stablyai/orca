# Headless Linux Server

Use this guide when you want to run `mcode serve` on a Linux machine without a
desktop session, such as an Ubuntu VPS or a remote build box.

`mcode serve` starts the MCode runtime without opening the desktop window. On
Linux, the packaged AppImage still needs the libraries that Electron expects at
startup. Current MCode builds start Xvfb automatically for `mcode serve` when no
`DISPLAY` is set, but Xvfb must be installed first. A separate D-Bus session is
not required. When `DISPLAY` is set, MCode uses that display instead of starting
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
cd /opt/mcode
./mcode-linux.AppImage --appimage-extract
/opt/mcode/squashfs-root/AppRun serve --port 6768
```

Docker commonly has no FUSE device. Use `--appimage-extract` once or
`--appimage-extract-and-run`; neither requires a privileged container. The
extract-and-run wrapper can print extracted paths before MCode starts, so
automation that requires stdout to contain only the ready JSON should extract
once and invoke `squashfs-root/AppRun`.

Download and make the AppImage executable:

```bash
sudo mkdir -p /opt/mcode
sudo curl -L https://github.com/mcode-ide/mcode/releases/latest/download/mcode-linux.AppImage \
  -o /opt/mcode/mcode-linux.AppImage
sudo chmod +x /opt/mcode/mcode-linux.AppImage
```

If `Xvfb` was installed somewhere other than `/usr/bin`, confirm systemd can
find it later:

```bash
command -v Xvfb
```

## Run In The Foreground

Start with a foreground run before creating a service:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/mcode/mcode-linux.AppImage serve --port 6768
```

For remote clients, pass the address they should use to reach this server. A
Tailscale address is usually the safest option for private servers:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/mcode/mcode-linux.AppImage serve \
  --port 6768 \
  --pairing-address 100.64.1.20
```

`--pairing-address` is only the address advertised to clients. It does not
change the listener bind address. MCode binds its WebSocket listener, then
combines the actual bound port with the advertised host when the address omits
a port. Use a reachable LAN/Tailscale hostname or IP, or a complete reverse
proxy URL such as `https://mcode.example.com/runtime` (`http(s)` is normalized
to `ws(s)`). Wildcard addresses such as `*`, `0.0.0.0`, and `::` cannot be
advertised.

The command writes one ready block to stdout after the listener bind and
pairing initialization complete:

```text
MCode server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://100.64.1.20:6768
Pairing URL: mcode://pair?code=...
```

For supervisors, request the versioned single-line JSON contract:

```bash
/opt/mcode/mcode-linux.AppImage serve --port 6768 \
  --pairing-address 100.64.1.20 --json
```

The actual output is one compact line; this example is pretty-printed for
readability:

```json
{
  "type": "mcode_server_ready",
  "schemaVersion": 1,
  "runtimeId": "...",
  "endpoint": "ws://0.0.0.0:6768",
  "boundEndpoint": "ws://0.0.0.0:6768",
  "advertisedEndpoint": "ws://100.64.1.20:6768",
  "managedWslCliReconciliation": "settled",
  "pairing": {
    "available": true,
    "url": "mcode://pair?code=...",
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
sudo useradd --system --create-home --shell /usr/sbin/nologin mcode
sudo chown root:root /opt/mcode /opt/mcode/mcode-linux.AppImage
sudo chmod 755 /opt/mcode /opt/mcode/mcode-linux.AppImage
```

For most hosts, one `mcode serve` service is enough because MCode starts Xvfb on
display `:99` when no display exists:

```ini
# /etc/systemd/system/mcode-serve.service
[Unit]
Description=MCode runtime server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=mcode
WorkingDirectory=/home/mcode
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/mcode/mcode-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
StandardOutput=journal
StandardError=journal
KillMode=mixed
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that
clients should use.

`KillMode=mixed` sends the graceful stop signal only to MCode's main process,
then retains systemd's cgroup-wide `SIGKILL` fallback if shutdown times out.
This lets MCode keep its owned Xvfb alive until Electron disconnects cleanly.

Exit status `3` means another process already owns this userData profile, so
`RestartPreventExitStatus=3` stops the unit instead of retrying a launch that
cannot succeed. Any other permanent startup fault is capped at 5 starts per
5 minutes; systemd's defaults (10s window, 5 starts) can never trip at
`RestartSec=5`, which is how one bad launch could restart thousands of times.
The start limit counts operator-initiated starts too, so once it trips systemd
refuses a plain `systemctl start` until the 5-minute window rolls over. Run
`sudo systemctl reset-failed mcode-serve.service` first to clear it — the
[Upgrade](#upgrade-steps) and [Roll back](#roll-back) scripts already do.
On systemd older than 230 those two directives are spelled
`StartLimitInterval=`/`StartLimitBurst=` and belong in `[Service]`; Ubuntu
20.04, MCode's oldest supported base, ships systemd 245.

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcode-serve.service
sudo journalctl -u mcode-serve.service -f
```

`journalctl -o cat` removes journal metadata but still mixes the service's
stdout and stderr. Parse each line as JSON and require the readiness type and
schema before treating the service as ready:

```bash
sudo journalctl -u mcode-serve.service -o cat \
  | jq -Rrc 'fromjson? | select(.type == "mcode_server_ready" and .schemaVersion == 1)'
```

A bounded health check should require that contract within its startup timeout;
otherwise inspect earlier diagnostics for the precise pairing reason, listener
error, or missing library.

## Managed Xvfb Service

If you prefer to own the virtual display lifecycle in systemd, run Xvfb as a
separate service and set `DISPLAY=:99` for MCode.

```ini
# /etc/systemd/system/mcode-xvfb.service
[Unit]
Description=Virtual X display for MCode
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

Then add the display dependency to the MCode service:

```ini
# /etc/systemd/system/mcode-serve.service
[Unit]
Description=MCode runtime server
After=network-online.target mcode-xvfb.service
Wants=network-online.target mcode-xvfb.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=mcode
WorkingDirectory=/home/mcode
Environment=DISPLAY=:99
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/mcode/mcode-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartPreventExitStatus=3
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable both units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcode-xvfb.service mcode-serve.service
```

## CLI Install Note

On a headless host, you do not need to open the desktop UI just to run the
server. Invoke the AppImage directly:

```bash
/opt/mcode/mcode-linux.AppImage serve --help
```

Running an AppImage as root requires Chromium's `--no-sandbox` switch before
the command:

```bash
/opt/mcode/mcode-linux.AppImage --no-sandbox serve --port 6768
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
  MCode changes it.
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

If you later install the desktop CLI from MCode settings, use that CLI for normal
shell workflows. Keep the AppImage path in systemd so service restarts do not
depend on an interactive shell profile.

## Upgrade

`mcode serve` never updates itself. In headless mode MCode wires up no auto-updater
at all — the built-in updater only runs in the desktop GUI, and no paired mobile
or web client can trigger it remotely. Upgrading is always a deliberate step:
replace the AppImage and restart the service.

Two facts make this safe and predictable:

- **State lives in the service user's home, not next to the binary.** Persisted
  data is under `/home/mcode/.config/` (MCode uses both an `mcode` and an `MCode`
  directory there), fully independent of `/opt/mcode/mcode-linux.AppImage`.
  Replacing the binary never touches projects, worktree metadata, terminal
  history, orchestration state, or paired-device keys — so mobile and web
  clients reconnect after an upgrade without re-pairing.
- **New builds migrate old state on load.** MCode loads older `mcode-data.json`
  state into the current schema and writes it back in the current shape, so a
  forward upgrade needs no manual data step.

Rolling back is the case that needs care — see [Roll back](#roll-back).

### Record the version you deploy

MCode has no headless version command: there is no `--version` flag or `version`
subcommand, and `mcode serve` prints only its endpoint. Choose a release tag
explicitly instead of following the `latest` URL, and record it next to the
binary so upgrades are auditable. The steps below keep that record in
`/opt/mcode/VERSION`.

### Upgrade steps

Never download straight onto `/opt/mcode/mcode-linux.AppImage`. The AppImage is
FUSE-mounted, so overwriting it in place while the service runs can crash or
corrupt the live process — and even with the service stopped, a failed or partial
download would clobber the working binary. Instead download to a temporary name
on the same filesystem, verify it, then swap it in with an atomic rename.

Check capacity before starting:

```bash
sudo chown root:root /opt/mcode
sudo chmod 755 /opt/mcode
sudo test ! -L /opt/mcode/mcode-linux.AppImage
sudo chown root:root /opt/mcode/mcode-linux.AppImage
sudo chmod 755 /opt/mcode/mcode-linux.AppImage
# Clear predictable staging names left by an older attempt after locking the directory
sudo rm -f /opt/mcode/mcode-linux.AppImage.new /opt/mcode/VERSION.new \
  /opt/mcode/mcode-linux.AppImage.recovering /opt/mcode/VERSION.recovering
sudo du -sh /home/mcode/.config
df -h /opt/mcode /home/mcode
```

`/opt/mcode` needs room for the compressed MCode profile archive, the staged
build, and the rollback binary. A rollback extracts the old profile and preserves
the post-upgrade MCode profile directories, so `/home` needs room for both copies.

Run the following block as one Bash script so its fail-fast and recovery traps
remain active for the whole operation:

```bash
set -euo pipefail

# Replace this example with the release tag you intend to deploy
MCODE_VERSION=v1.4.147

# Select the release asset on the server where MCode runs
case "$(uname -m)" in
  x86_64)
    MCODE_ASSET=mcode-linux.AppImage
    MCODE_FILE_MACHINE=x86-64
    ;;
  aarch64 | arm64)
    MCODE_ASSET=mcode-linux-arm64.AppImage
    MCODE_FILE_MACHINE='ARM aarch64'
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

MCODE_ROLLBACK_NEW=
MCODE_ROLLBACK=
MCODE_SERVICE_STOPPED=0
MCODE_BINARY_PROMOTED=0
recover_failed_upgrade() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0)); then
    sudo rm -f /opt/mcode/mcode-linux.AppImage.new /opt/mcode/VERSION.new \
      /opt/mcode/mcode-linux.AppImage.recovering /opt/mcode/VERSION.recovering
  fi
  if ((exit_status != 0)) && [[ -n "$MCODE_ROLLBACK_NEW" ]] && \
    sudo test -d "$MCODE_ROLLBACK_NEW"; then
    sudo rm -rf -- "$MCODE_ROLLBACK_NEW"
  fi
  if ((exit_status != 0 && MCODE_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((MCODE_BINARY_PROMOTED)); then
      if ! sudo cp -a "$MCODE_ROLLBACK/mcode-linux.AppImage" \
        /opt/mcode/mcode-linux.AppImage.recovering || \
        ! sudo mv -f /opt/mcode/mcode-linux.AppImage.recovering \
          /opt/mcode/mcode-linux.AppImage; then
        recovery_ok=0
      fi
      if sudo test -f "$MCODE_ROLLBACK/VERSION"; then
        if ! sudo cp -a "$MCODE_ROLLBACK/VERSION" /opt/mcode/VERSION.recovering || \
          ! sudo mv -f /opt/mcode/VERSION.recovering /opt/mcode/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo rm -f /opt/mcode/VERSION; then
        recovery_ok=0
      fi
    fi
    sudo rm -f /opt/mcode/mcode-linux.AppImage.recovering \
      /opt/mcode/VERSION.recovering
    if ((recovery_ok)); then
      # A tripped StartLimitBurst refuses a plain start
      sudo systemctl reset-failed mcode-serve.service || true
      sudo systemctl start mcode-serve.service || true
    else
      echo 'Upgrade recovery failed; service remains stopped' >&2
    fi
  fi
  exit "$exit_status"
}
trap recover_failed_upgrade EXIT

# 1. Stage and verify the new build while the server stays online
sudo curl -fL --retry 3 "https://github.com/mcode-ide/mcode/releases/download/${MCODE_VERSION}/${MCODE_ASSET}" \
  -o /opt/mcode/mcode-linux.AppImage.new
sudo chown root:root /opt/mcode/mcode-linux.AppImage.new
sudo chmod 755 /opt/mcode/mcode-linux.AppImage.new

# Both checks must match; either grep stops this fail-fast block otherwise
MCODE_FILE_INFO=$(LC_ALL=C file /opt/mcode/mcode-linux.AppImage.new)
grep 'ELF .* executable' <<<"$MCODE_FILE_INFO"
grep -F "$MCODE_FILE_MACHINE" <<<"$MCODE_FILE_INFO"

# 2. Assemble the prior binary and version in a root-only rollback bundle
MCODE_ROLLBACK_BASE=/opt/mcode/mcode-rollback-$(date +%F-%H%M%S-%N)
MCODE_ROLLBACK_NEW=${MCODE_ROLLBACK_BASE}.new
MCODE_ROLLBACK=${MCODE_ROLLBACK_BASE}.ready
sudo install -d -m 700 "$MCODE_ROLLBACK_NEW"
sudo cp -a /opt/mcode/mcode-linux.AppImage "$MCODE_ROLLBACK_NEW/mcode-linux.AppImage"
if sudo test -f /opt/mcode/VERSION; then
  sudo cp -a /opt/mcode/VERSION "$MCODE_ROLLBACK_NEW/VERSION"
fi

# Stage the new version record before the stop window
printf '%s\n' "$MCODE_VERSION" | sudo tee /opt/mcode/VERSION.new >/dev/null
sudo chown root:root /opt/mcode/VERSION.new
sudo chmod 644 /opt/mcode/VERSION.new

# 3. Stop the server so the profile backup is consistent
MCODE_SERVICE_STOPPED=1
sudo systemctl stop mcode-serve.service

# Add only MCode-owned profile directories, then publish the complete bundle
MCODE_PROFILE_DIRS=()
for profile_dir in mcode MCode; do
  if sudo test -L "/home/mcode/.config/$profile_dir"; then
    echo "Refusing symlinked MCode profile: /home/mcode/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/mcode/.config/$profile_dir"; then
    if [[ "$profile_dir" == MCode ]] && \
      sudo test /home/mcode/.config/mcode -ef /home/mcode/.config/MCode; then
      continue
    fi
    MCODE_PROFILE_DIRS+=("$profile_dir")
  fi
done
if ((${#MCODE_PROFILE_DIRS[@]} == 0)); then
  echo 'No MCode profile directory found under /home/mcode/.config' >&2
  exit 1
fi
sudo tar czf "$MCODE_ROLLBACK_NEW/profile.tgz" \
  -C /home/mcode/.config "${MCODE_PROFILE_DIRS[@]}"
sudo chmod 600 "$MCODE_ROLLBACK_NEW/profile.tgz"
sudo mv "$MCODE_ROLLBACK_NEW" "$MCODE_ROLLBACK"

# 4. Atomically replace the binary and version record, then start
MCODE_BINARY_PROMOTED=1
sudo mv -f /opt/mcode/mcode-linux.AppImage.new /opt/mcode/mcode-linux.AppImage
sudo mv -f /opt/mcode/VERSION.new /opt/mcode/VERSION
# Clears a start-limit hit left by the version being replaced
sudo systemctl reset-failed mcode-serve.service
sudo systemctl start mcode-serve.service
MCODE_SERVICE_STOPPED=0
trap - EXIT
```

The profile archive created in step 3 captures both MCode profile directory names
when present without rewinding unrelated tools under `/home/mcode/.config`. The
`.ready` suffix is published only after the prior binary, version record, and
profile archive are complete. If you run the managed Xvfb unit, only
`mcode-serve.service` needs restarting — leave `mcode-xvfb.service` running.

### Verify

```bash
sudo journalctl -u mcode-serve.service -f
```

A healthy start prints one `MCode server ready` block with the actual bound and
advertised endpoints. Verify those values rather than assuming the configured
port, because a collision can select a fallback port.
Confirm a client reconnects before you discard the backup. The timestamped
rollback bundles are not pruned automatically. After the new version satisfies
your retention policy, select and inspect the newest complete bundle before
removing it:

```bash
shopt -s nullglob
MCODE_ROLLBACK_SETS=(/opt/mcode/mcode-rollback-*.ready)
((${#MCODE_ROLLBACK_SETS[@]} > 0))
MCODE_ROLLBACK=${MCODE_ROLLBACK_SETS[${#MCODE_ROLLBACK_SETS[@]} - 1]}
printf 'Removing rollback bundle: %s\n' "$MCODE_ROLLBACK"
sudo test -d "$MCODE_ROLLBACK"
sudo rm -rf -- "$MCODE_ROLLBACK"
```

Each `.ready` directory is a self-contained rollback generation; never combine
files from different bundles.

### Roll back

A rollback is **not** binary-only safe. Once a newer build has started, it can
rewrite `mcode-data.json` in the current schema. If an older build then writes
that file, it can discard fields it does not recognize. The rolling
`mcode-data.json.bak.*` files are corruption-recovery snapshots, not a dedicated
pre-upgrade copy, and normal writes can rotate them away. To roll back cleanly,
restore the backup from step 3 **and** swap the binary back. Run this block as one
Bash script:

```bash
set -euo pipefail

# Select and validate one complete generation before taking the service offline
shopt -s nullglob
MCODE_ROLLBACK_SETS=(/opt/mcode/mcode-rollback-*.ready)
((${#MCODE_ROLLBACK_SETS[@]} > 0))
MCODE_ROLLBACK=${MCODE_ROLLBACK_SETS[${#MCODE_ROLLBACK_SETS[@]} - 1]}
sudo test -f "$MCODE_ROLLBACK/mcode-linux.AppImage"
sudo tar tzf "$MCODE_ROLLBACK/profile.tgz" >/dev/null

# Extract and validate the old profile while the current server stays online
sudo test ! -L /home
MCODE_HOME_OWNER=$(sudo stat -c %u /home)
MCODE_HOME_MODE=$(sudo stat -c %a /home)
if [[ "$MCODE_HOME_OWNER" != 0 ]] || ((8#$MCODE_HOME_MODE & 0022)) || \
  sudo -u mcode test -w /home; then
  echo 'Refusing rollback because /home is not root-controlled' >&2
  exit 1
fi
MCODE_RESTORE=$(sudo mktemp -d /home/.mcode-restore.XXXXXX)
MCODE_SERVICE_STOPPED=0
MCODE_MOVED_CURRENT_DIRS=()
MCODE_INSTALLED_RESTORE_DIRS=()
MCODE_CURRENT_BINARY_MOVED=0
MCODE_CURRENT_VERSION_MOVED=0
MCODE_VERSION_REPLACEMENT_STARTED=0
MCODE_POST_UPGRADE=
MCODE_ROLLBACK_BINARY_STAGED=
MCODE_ROLLBACK_VERSION_STAGED=
MCODE_ROLLBACK_HAS_VERSION=0
restart_after_rollback_error() {
  exit_status=$?
  trap - EXIT
  set +e
  if ((exit_status != 0 && MCODE_SERVICE_STOPPED)); then
    recovery_ok=1
    if ((${#MCODE_INSTALLED_RESTORE_DIRS[@]})); then
      for profile_dir in "${MCODE_INSTALLED_RESTORE_DIRS[@]}"; do
        if sudo test -d "/home/mcode/.config/$profile_dir"; then
          if ! sudo mv "/home/mcode/.config/$profile_dir" \
            "$MCODE_RESTORE/$profile_dir.failed"; then
            recovery_ok=0
          fi
        fi
      done
    fi
    if ((${#MCODE_MOVED_CURRENT_DIRS[@]})); then
      for profile_dir in "${MCODE_MOVED_CURRENT_DIRS[@]}"; do
        if sudo test -d "$MCODE_POST_UPGRADE/$profile_dir"; then
          if ! sudo mv "$MCODE_POST_UPGRADE/$profile_dir" /home/mcode/.config/; then
            recovery_ok=0
          fi
        elif ! sudo test -d "/home/mcode/.config/$profile_dir"; then
          recovery_ok=0
        fi
      done
    fi
    if [[ -n "$MCODE_POST_UPGRADE" ]]; then
      sudo rmdir "$MCODE_POST_UPGRADE" 2>/dev/null || true
    fi
    if ((MCODE_CURRENT_BINARY_MOVED)); then
      if sudo test -f "$MCODE_CURRENT_BINARY"; then
        if ! sudo mv -f "$MCODE_CURRENT_BINARY" /opt/mcode/mcode-linux.AppImage; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/mcode/mcode-linux.AppImage; then
        recovery_ok=0
      fi
    fi
    if ((MCODE_CURRENT_VERSION_MOVED)); then
      if sudo test -f "$MCODE_CURRENT_VERSION"; then
        if ! sudo mv -f "$MCODE_CURRENT_VERSION" /opt/mcode/VERSION; then
          recovery_ok=0
        fi
      elif ! sudo test -f /opt/mcode/VERSION; then
        recovery_ok=0
      fi
    elif ((MCODE_VERSION_REPLACEMENT_STARTED)); then
      if ! sudo rm -f /opt/mcode/VERSION; then
        recovery_ok=0
      fi
    fi
    if ((recovery_ok)); then
      # A tripped StartLimitBurst refuses a plain start
      sudo systemctl reset-failed mcode-serve.service || true
      sudo systemctl start mcode-serve.service || true
    else
      echo 'Rollback recovery failed; service remains stopped' >&2
    fi
  fi
  if [[ -n "$MCODE_ROLLBACK_BINARY_STAGED" ]]; then
    sudo rm -f -- "$MCODE_ROLLBACK_BINARY_STAGED"
  fi
  if [[ -n "$MCODE_ROLLBACK_VERSION_STAGED" ]]; then
    sudo rm -f -- "$MCODE_ROLLBACK_VERSION_STAGED"
  fi
  sudo rm -rf -- "$MCODE_RESTORE"
  exit "$exit_status"
}
trap restart_after_rollback_error EXIT

if [[ "$(sudo stat -c %d "$MCODE_RESTORE")" != \
  "$(sudo stat -c %d /home/mcode/.config)" ]]; then
  echo 'Refusing rollback because staging and the MCode profile are on different filesystems' >&2
  exit 1
fi
sudo tar xzf "$MCODE_ROLLBACK/profile.tgz" -C "$MCODE_RESTORE"
MCODE_RESTORE_DIRS=()
for profile_dir in mcode MCode; do
  if sudo test -L "$MCODE_RESTORE/$profile_dir"; then
    echo "Rollback bundle contains a symlinked profile: $profile_dir" >&2
    exit 1
  fi
  if sudo test -d "$MCODE_RESTORE/$profile_dir"; then
    if [[ "$profile_dir" == MCode ]] && \
      sudo test "$MCODE_RESTORE/mcode" -ef "$MCODE_RESTORE/MCode"; then
      continue
    fi
    MCODE_RESTORE_DIRS+=("$profile_dir")
  fi
done
if ((${#MCODE_RESTORE_DIRS[@]} == 0)); then
  echo "Rollback bundle has no MCode profile directories: $MCODE_ROLLBACK" >&2
  exit 1
fi
for profile_dir in "${MCODE_RESTORE_DIRS[@]}"; do
  sudo chown -R mcode:mcode "$MCODE_RESTORE/$profile_dir"
done

MCODE_ROLLBACK_STAMP=$(date +%F-%H%M%S-%N)
MCODE_ROLLBACK_BINARY_STAGED=/opt/mcode/mcode-linux.AppImage.rollback-staged-$MCODE_ROLLBACK_STAMP
sudo cp -a "$MCODE_ROLLBACK/mcode-linux.AppImage" "$MCODE_ROLLBACK_BINARY_STAGED"
if sudo test -f "$MCODE_ROLLBACK/VERSION"; then
  MCODE_ROLLBACK_HAS_VERSION=1
  MCODE_ROLLBACK_VERSION_STAGED=/opt/mcode/VERSION.rollback-staged-$MCODE_ROLLBACK_STAMP
  sudo cp -a "$MCODE_ROLLBACK/VERSION" "$MCODE_ROLLBACK_VERSION_STAGED"
fi

MCODE_SERVICE_STOPPED=1
sudo systemctl stop mcode-serve.service

# Preserve and replace only MCode-owned profile directories
MCODE_CURRENT_DIRS=()
for profile_dir in mcode MCode; do
  if sudo test -L "/home/mcode/.config/$profile_dir"; then
    echo "Refusing symlinked MCode profile: /home/mcode/.config/$profile_dir" >&2
    exit 1
  fi
  if sudo test -d "/home/mcode/.config/$profile_dir"; then
    if [[ "$profile_dir" == MCode ]] && \
      sudo test /home/mcode/.config/mcode -ef /home/mcode/.config/MCode; then
      continue
    fi
    MCODE_CURRENT_DIRS+=("$profile_dir")
  fi
done
MCODE_POST_UPGRADE=/home/mcode/.config/mcode-rollback-$MCODE_ROLLBACK_STAMP
sudo install -d -o mcode -g mcode -m 700 "$MCODE_POST_UPGRADE"
if ((${#MCODE_CURRENT_DIRS[@]})); then
  for profile_dir in "${MCODE_CURRENT_DIRS[@]}"; do
    MCODE_MOVED_CURRENT_DIRS+=("$profile_dir")
    sudo mv "/home/mcode/.config/$profile_dir" "$MCODE_POST_UPGRADE/"
  done
fi
for profile_dir in "${MCODE_RESTORE_DIRS[@]}"; do
  MCODE_INSTALLED_RESTORE_DIRS+=("$profile_dir")
  sudo mv "$MCODE_RESTORE/$profile_dir" /home/mcode/.config/
done

MCODE_CURRENT_BINARY=/opt/mcode/mcode-linux.AppImage.rollback-current-$MCODE_ROLLBACK_STAMP
MCODE_CURRENT_BINARY_MOVED=1
sudo mv /opt/mcode/mcode-linux.AppImage "$MCODE_CURRENT_BINARY"
sudo mv -f "$MCODE_ROLLBACK_BINARY_STAGED" /opt/mcode/mcode-linux.AppImage

MCODE_CURRENT_VERSION=/opt/mcode/VERSION.rollback-current-$MCODE_ROLLBACK_STAMP
if sudo test -f /opt/mcode/VERSION; then
  MCODE_CURRENT_VERSION_MOVED=1
  sudo mv /opt/mcode/VERSION "$MCODE_CURRENT_VERSION"
fi
MCODE_VERSION_REPLACEMENT_STARTED=1
if ((MCODE_ROLLBACK_HAS_VERSION)); then
  sudo mv -f "$MCODE_ROLLBACK_VERSION_STAGED" /opt/mcode/VERSION
else
  sudo rm -f /opt/mcode/VERSION
fi
# The crash-looping build you are rolling back from tripped StartLimitBurst
sudo systemctl reset-failed mcode-serve.service
sudo systemctl start mcode-serve.service
MCODE_SERVICE_STOPPED=0
sudo rm -rf -- "$MCODE_RESTORE"
trap - EXIT
```

Restoring the backup is required, not optional: swapping only the binary leaves
the newer `mcode-data.json` in place, where an older build can discard state it
does not understand. Keep the pre-upgrade backup until the new version is proven
on your host. The `mcode-rollback-*` directory inside `.config` is also retained
deliberately. The post-upgrade binary and version record are retained in
`/opt/mcode` with the same `rollback-current-<timestamp>` suffix. Inspect these
artifacts and remove them according to your retention policy after the rollback
is resolved.

## Installing Agent Skills Without A Desktop

MCode's agent skills (CLI usage, orchestration, computer use, etc.) are normally
installed from MCode Settings, which pre-fills an `npx skills add ... --global`
command in a terminal for you to run. A headless host has no Settings UI, so
use `mcode skills install` instead:

```bash
mcode skills install                                      # list installable skills
mcode skills install --skill mcode-cli --skill orchestration # install globally (default)
mcode skills install --skill mcode-cli --local              # install into the current project only
mcode skills install --all                                 # install every bundled skill
mcode skills install --all --dry-run                       # print the npx command without running it
```

This resolves the same `npx skills add <repo> --skill <name> ...` command
Settings would show you (adding `--global` unless `--local` is passed), then
runs it and forwards its output and exit code. It requires `node`/`npx` on the
host; it does not need a running MCode runtime.

Unlike the command Settings shows, the spawned one adds `npx --yes` and `-y`.
Without them the `skills` CLI opens an interactive agent picker and blocks
forever on any allocated TTY — which includes a normal `ssh` session. Use
`--dry-run` to see the exact command that will run.

Settings keeps that picker deliberately, because choosing which agents get a
skill is a real decision. A headless run cannot answer it, so instead of dropping
the choice MCode makes it explicitly: it passes an `--agent` list built from the
coding agents it detects on the host, plus the shared `.agents/skills` directory
it reads itself. Left to decide on its own with no agent detected, the `skills`
CLI installs into all ~75 agents it knows and leaves a config directory for each.
Override the targets yourself, or narrow to the shared directory alone:

```bash
mcode skills install --skill mcode-cli --agent claude-code,codex
mcode skills install --skill mcode-cli --agent universal
```

If MCode detects no agent at all, `mcode skills install` stops and asks for
`--agent` rather than guessing.

To refresh already-installed skills, `mcode skills update` mirrors the same
selection flags (`--skill`, `--all`, `--local`, `--dry-run`) and resolves to
`npx skills update <names...>` with a matching scope flag — `--global`, or
`--project` when you pass `--local`:

```bash
mcode skills update --all                                  # update every bundled skill globally
mcode skills update --skill mcode-cli --dry-run             # print the npx command without running it
```

`mcode skills update` only refreshes skills that are already installed — it exits
0 without doing anything for a skill that is missing, so install it first. More
generally, a 0 exit means the `skills` CLI ran without erroring, not that it
wrote anything; read its output to confirm what changed.

`--json` covers the skill listing and `--dry-run`. A real run streams the
`skills` CLI's own non-JSON output and rejects `--json`.

Both commands install onto the machine that runs them. In an MCode SSH workspace
or the WSL bridge the `mcode` shim forwards commands to the MCode host, so they
refuse to run there and print the command to run on the machine you want.

## Troubleshooting

- `dlopen(): error loading libfuse.so.2`: install `libfuse2`.
- `Missing X server or $DISPLAY`: install `xvfb`, or start the managed Xvfb
  service and set `DISPLAY=:99`.
- `Xvfb not found`: confirm `command -v Xvfb` and use that absolute path in the
  systemd unit.
- GPU or DRI warnings on a VPS: keep `LIBGL_ALWAYS_SOFTWARE=1` in the service
  environment.
- Chromium sandbox errors: confirm the service is running as the non-root
  `mcode` user and that `/opt/mcode` is readable by that user.
- Clients cannot connect: make sure `--pairing-address` is an address reachable
  from the client, and make sure firewalls allow the selected `--port`.
- Journal shows `Another MCode instance is already running for this userData
  profile` and the unit exits `3`: another process already owns the profile, so
  `RestartPreventExitStatus=3` leaves the unit `failed` on purpose. Find the
  owner with `systemctl status mcode-serve` and `pgrep -af mcode`. Stop it (or
  keep it and leave the unit down), then run
  `sudo systemctl reset-failed mcode-serve && sudo systemctl start mcode-serve` —
  `reset-failed` clears the failed state and any start-limit counter. If no owner
  exists, the lock is stale (Chromium recorded a pid that
  has since been reused): remove `SingletonLock` and `SingletonSocket` from the
  userData directory and start again. If an earlier crash-loop already leaked
  AppImage mounts, list them with `findmnt -rn -t fuse.mcode-linux.AppImage` and
  release only the ones with no live owner using `fusermount -uz <target>` (or
  `umount -l <target>`), leaving the running instance's mount alone.
- Service crash-loops right after an upgrade: use [Roll back](#roll-back) with
  the pre-upgrade `.ready` bundle. Do not rerun the upgrade first; doing so would
  make the crashing version the next rollback binary. The loop trips
  `StartLimitBurst`, so any manual `systemctl start` outside that script needs
  `sudo systemctl reset-failed mcode-serve.service` first.
- Diagnosing other missing libraries: extract the AppImage without launching it
  with `./mcode-linux.AppImage --appimage-extract`, then run
  `ldd squashfs-root/mcode` to list any shared libraries the host is missing.
