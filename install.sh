#!/usr/bin/env bash
# Orca headless server installer.
#
# Provisions everything docs/reference/headless-linux-server.md covers, on any
# systemd Linux with apt, dnf, yum, zypper, or pacman:
#
#   curl -fsSL https://raw.githubusercontent.com/stablyai/orca/main/install.sh | bash
#
# No sudo needed: by default everything lives under your home, the service is
# a systemd user unit kept alive via lingering, and Chromium uses the
# user-namespace sandbox. Run with sudo instead for a system-wide service
# (dedicated service user, /opt/orca, system unit).
#
# What it does: installs dependencies (curl, file, xvfb), downloads the release
# AppImage (sha512-verified against the release's latest-linux*.yml), uses the
# FUSE-free extraction path, keeps Chromium's sandbox enabled, writes and
# starts a systemd unit, waits for the ready block, and prints the pairing URL.
set -euo pipefail

REPO=stablyai/orca
INSTALL_DIR=""
SERVICE_NAME=orca-serve
SERVICE_USER=orca
PORT=6768
VERSION=""
PAIRING_ADDRESS=""
APPIMAGE_FILE=""
NO_START=0
UNINSTALL=0
PURGE=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

No sudo needed: as a regular user this performs a rootless install (under
~/.local/opt/orca, with a systemd user unit). Run with sudo for a system-wide
service instead.

  --pairing-address <addr>  Address advertised to clients (IP, hostname, or
                            proxy URL). Default: the host's default-route IP,
                            so pairing works from any network that can reach
                            this machine. Set explicitly for Tailscale/LAN-only
                            or reverse-proxy setups.
  --port <port>             WebSocket listener port (default 6768).
  --version <tag>           Release tag to install (default: latest).
  --user <name>             System-wide only: service user (default: orca,
                            created if missing). "root" runs the service as
                            root with --no-sandbox.
  --dir <path>              Install directory (default: /opt/orca system-wide,
                            ~/.local/opt/orca rootless).
  --appimage <path>         Use a local AppImage instead of downloading.
  --no-start                Install everything but do not enable/start the unit.
  --uninstall               Remove the service and install directory.
  --purge                   With --uninstall: also delete the service user and
                            its home (worktrees, pairing keys, terminal state).
  --help                    Show this help.
EOF
}

log() { printf '[orca-install] %s\n' "$*"; }
fail() { printf '[orca-install] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pairing-address) PAIRING_ADDRESS=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --user) SERVICE_USER=${2:?}; shift 2 ;;
    --dir) INSTALL_DIR=${2:?}; shift 2 ;;
    --appimage) APPIMAGE_FILE=${2:?}; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --help | -h) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

# Why: no-sudo runs are first-class, not an error - they install per-user with
# a systemd user unit instead of demanding root.
ROOTLESS=0
if [ "$(id -u)" -ne 0 ]; then
  ROOTLESS=1
  SERVICE_USER=$(id -un)
  SERVICE_HOME=$HOME
  [ -n "$INSTALL_DIR" ] || INSTALL_DIR=$HOME/.local/opt/orca
  UNIT=$HOME/.config/systemd/user/$SERVICE_NAME.service
  SC="systemctl --user"
  JC="journalctl --user"
else
  [ -n "$INSTALL_DIR" ] || INSTALL_DIR=/opt/orca
  UNIT=/etc/systemd/system/$SERVICE_NAME.service
  SC=systemctl
  JC=journalctl
fi

HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if [ "$ROOTLESS" -eq 0 ] || $SC show-environment >/dev/null 2>&1; then
    HAS_SYSTEMD=1
  fi
fi

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$HAS_SYSTEMD" -eq 1 ]; then
    $SC disable --now "$SERVICE_NAME.service" 2>/dev/null || true
  fi
  rm -f "$UNIT"
  [ "$HAS_SYSTEMD" -eq 1 ] && $SC daemon-reload
  rm -rf "$INSTALL_DIR"
  log "removed $UNIT and $INSTALL_DIR"
  if [ "$PURGE" -eq 1 ] && [ "$ROOTLESS" -eq 0 ] && [ "$SERVICE_USER" != root ] &&
    id "$SERVICE_USER" >/dev/null 2>&1; then
    userdel -r "$SERVICE_USER" 2>/dev/null || userdel "$SERVICE_USER"
    log "removed user $SERVICE_USER"
  elif [ "$PURGE" -eq 1 ] && [ "$ROOTLESS" -eq 1 ]; then
    rm -rf "$HOME/.config/orca"
    log "removed $HOME/.config/orca"
  else
    log "kept service user and state; pass --purge to remove them"
  fi
  exit 0
fi

case "$(uname -m)" in
  x86_64) ASSET=orca-linux.AppImage; META=latest-linux.yml; MACHINE=x86-64 ;;
  aarch64 | arm64) ASSET=orca-linux-arm64.AppImage; META=latest-linux-arm64.yml; MACHINE='ARM aarch64' ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

install_deps() {
  # Why: xvfb is required for browser panes (orca serve auto-starts it); curl
  # and file are used below. Detect the package manager instead of assuming apt.
  # Why: iproute provides `ip route get`, which pairing-address autodetection
  # needs on minimal images where `hostname -I` is absent or empty.
  local pkgs="curl file xvfb iproute2"
  if [ "$ROOTLESS" -eq 1 ]; then
    # Why: rootless cannot install packages; verify what is present and say
    # exactly what to ask an admin for.
    command -v curl >/dev/null 2>&1 || fail "curl is required (apt/dnf install curl, or rerun with sudo)"
    command -v file >/dev/null 2>&1 || fail "file is required (apt/dnf install file, or rerun with sudo)"
    command -v Xvfb >/dev/null 2>&1 ||
      log "WARNING: Xvfb not found; the server runs but browser panes stay unavailable (apt/dnf install xvfb)"
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || log "WARNING: apt-get update failed; installing from cached indexes"
    # Why: piped installs have no TTY; debconf must never prompt.
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl file iproute xorg-x11-server-Xvfb
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl file iproute xorg-x11-server-Xvfb
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install curl file iproute2 xvfb-run xorg-x11-server-Xvfb 2>/dev/null ||
      zypper --non-interactive install curl file iproute2 xorg-x11-server
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed curl file iproute2 xorg-server-xvfb
  else
    log "no supported package manager found; continuing with existing binaries"
  fi
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v file >/dev/null 2>&1 || fail "file is required"
  command -v Xvfb >/dev/null 2>&1 ||
    log "WARNING: Xvfb not found; the server runs but browser panes stay unavailable"
}

resolve_version() {
  [ -n "$VERSION" ] && return
  if [ -n "$APPIMAGE_FILE" ]; then
    # Why: a local AppImage's tag is unknown; record that instead of guessing.
    VERSION=local
    return
  fi
  # Why: the releases/latest redirect carries the tag without needing an API
  # token or jq.
  local location
  location=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
    fail "could not resolve the latest release"
  VERSION=${location##*/}
  case "$VERSION" in v[0-9]*) ;; *) fail "unexpected latest release tag: $VERSION" ;; esac
}

verify_sha512() {
  # Why: releases publish electron-updater metadata with a base64 sha512 per
  # asset; verifying it turns curl|bash from "trust the pipe" into "trust the
  # release". Skipped with a warning when the metadata or openssl is missing.
  local file=$1 meta_url=$2 expected actual
  if ! command -v openssl >/dev/null 2>&1; then
    log "WARNING: openssl not found; skipping sha512 verification"
    return 0
  fi
  expected=$(curl -fsSL "$meta_url" 2>/dev/null |
    awk -v asset="$ASSET" '
      /url:/ { current = $NF }
      /sha512:/ && current == asset && !found { print $NF; found = 1 }
    ') || true
  if [ -z "$expected" ]; then
    log "WARNING: no sha512 for $ASSET in release metadata; skipping verification"
    return 0
  fi
  actual=$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)
  [ "$actual" = "$expected" ] || fail "sha512 mismatch for $file (expected $expected)"
  log "sha512 verified"
}

fetch_appimage() {
  local target=$INSTALL_DIR/orca-linux.AppImage
  if [ -n "$APPIMAGE_FILE" ]; then
    [ -f "$APPIMAGE_FILE" ] || fail "no such file: $APPIMAGE_FILE"
    cp -f "$APPIMAGE_FILE" "$target.new"
  else
    log "downloading $ASSET $VERSION"
    curl -fL --retry 3 -o "$target.new" \
      "https://github.com/$REPO/releases/download/$VERSION/$ASSET" ||
      fail "download failed"
    verify_sha512 "$target.new" "https://github.com/$REPO/releases/download/$VERSION/$META"
  fi
  local info
  info=$(LC_ALL=C file "$target.new")
  case "$info" in
    *'ELF 64-bit'*"$MACHINE"*) ;;
    *) fail "downloaded asset is not a $MACHINE ELF: $info" ;;
  esac
  chmod 755 "$target.new"
  mv -f "$target.new" "$target"
}

extract_appimage() {
  # Why: the extraction path needs no FUSE and works identically on bare VPSes
  # and containers. AppRun outside the AppImage runtime cannot autodetect
  # APPDIR when the first argument is a command, so the unit sets it explicitly.
  local scratch=$INSTALL_DIR/.extract.$$
  rm -rf "$scratch" && mkdir -p "$scratch"
  (cd "$scratch" && "$INSTALL_DIR/orca-linux.AppImage" --appimage-extract >/dev/null) ||
    { rm -rf "$scratch"; fail "AppImage extraction failed"; }
  rm -rf "$INSTALL_DIR/squashfs-root"
  mv "$scratch/squashfs-root" "$INSTALL_DIR/squashfs-root"
  rm -rf "$scratch"
}

ensure_user() {
  [ "$ROOTLESS" -eq 1 ] && return
  [ "$SERVICE_USER" = root ] && { SERVICE_HOME=/root; return; }
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    local shell
    shell=$(command -v nologin || echo /usr/sbin/nologin)
    useradd --system --create-home --shell "$shell" "$SERVICE_USER" ||
      fail "could not create user $SERVICE_USER"
    log "created service user $SERVICE_USER"
  fi
  SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  [ -d "$SERVICE_HOME" ] || fail "service user $SERVICE_USER has no home directory"
}

configure_sandbox() {
  NO_SANDBOX_FLAG=""
  if [ "$ROOTLESS" -eq 1 ]; then
    # Why: without root the setuid helper cannot be restored, so Chromium needs
    # the user-namespace sandbox. Probe for it; only fall back to --no-sandbox
    # when the kernel/distro forbids unprivileged user namespaces.
    if command -v unshare >/dev/null 2>&1 &&
      ! unshare --user --map-root-user true 2>/dev/null; then
      NO_SANDBOX_FLAG="--no-sandbox "
      log "WARNING: unprivileged user namespaces are disabled on this host; running with --no-sandbox"
    fi
    return 0
  fi
  # Why: extraction drops the setuid bit chrome-sandbox needs; restoring it
  # keeps Chromium's sandbox enabled for the unprivileged service user. Root
  # cannot use the sandbox at all, so root mode passes --no-sandbox instead.
  if [ "$SERVICE_USER" = root ]; then
    NO_SANDBOX_FLAG="--no-sandbox "
    log "WARNING: running as root disables Chromium's sandbox; prefer the default service user"
  else
    chown root:root "$INSTALL_DIR/squashfs-root/chrome-sandbox"
    chmod 4755 "$INSTALL_DIR/squashfs-root/chrome-sandbox"
  fi
}

resolve_pairing_address() {
  [ -n "$PAIRING_ADDRESS" ] && return
  # Why: the listener always binds every interface; the pairing URL just needs
  # one dialable address, and wildcards cannot be advertised. The default-route
  # source IP is the address reachable from the widest set of networks, so a
  # zero-flag install works out of the box. Use --pairing-address for
  # Tailscale/LAN-only or reverse-proxy setups.
  if command -v ip >/dev/null 2>&1; then
    PAIRING_ADDRESS=$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || true
  fi
  [ -z "$PAIRING_ADDRESS" ] && PAIRING_ADDRESS=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  [ -n "$PAIRING_ADDRESS" ] || fail "could not determine a pairing address; pass --pairing-address"
  log "advertising $PAIRING_ADDRESS (listener binds all interfaces; override with --pairing-address)"
}

write_unit() {
  # Why: HOME is explicit because systemd omits it for User=root system units
  # and Chromium then splits profile state (including pairing keys) into /tmp.
  # User= is only valid in system units; user units already run as the user.
  local user_line=""
  if [ "$ROOTLESS" -eq 0 ] && [ "$SERVICE_USER" != root ]; then
    user_line="User=$SERVICE_USER"
  fi
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<EOF
[Unit]
Description=Orca runtime server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$user_line
WorkingDirectory=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=APPDIR=$INSTALL_DIR/squashfs-root
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=$INSTALL_DIR/squashfs-root/AppRun ${NO_SANDBOX_FLAG}serve --port $PORT --pairing-address $PAIRING_ADDRESS
Restart=on-failure
RestartSec=5

[Install]
WantedBy=$([ "$ROOTLESS" -eq 1 ] && echo default.target || echo multi-user.target)
EOF
}

start_and_report() {
  $SC daemon-reload
  local start_marker
  start_marker=$(date '+%Y-%m-%d %H:%M:%S')
  $SC enable --now "$SERVICE_NAME.service"
  if [ "$ROOTLESS" -eq 1 ]; then
    # Why: without lingering, the user manager and the server die at logout.
    loginctl enable-linger "$(id -un)" 2>/dev/null ||
      log "WARNING: could not enable lingering; the server stops when you log out (ask an admin: loginctl enable-linger $(id -un))"
  fi
  log "waiting for the server ready block (up to 120s)"
  local i ready=""
  for i in $(seq 1 40); do
    if $SC is-active --quiet "$SERVICE_NAME.service" &&
      $JC -u "$SERVICE_NAME.service" --since "$start_marker" 2>/dev/null |
      grep -q 'Orca server ready'; then
      ready=1
      break
    fi
    sleep 3
  done
  if [ -z "$ready" ]; then
    fail "server did not report ready; inspect: $JC -u $SERVICE_NAME.service -e"
  fi
  log "server ready"
  $JC -u "$SERVICE_NAME.service" --since "$start_marker" 2>/dev/null |
    grep -E 'Bound endpoint|Advertised endpoint|Web client URL|Pairing URL' |
    sed 's/^.*\(Bound endpoint\|Advertised endpoint\|Web client URL\|Pairing URL\)/\1/'
  cat <<EOF

Pair a client: Orca desktop/mobile -> Settings -> Remote Orca Servers ->
Add Server -> paste the pairing URL above. Treat the pairing URL as a secret.
Install agent CLIs (claude, codex, ...) for user $SERVICE_USER on this host;
remote sessions use this machine's credentials.
EOF
}

install_deps
resolve_version
mkdir -p "$INSTALL_DIR"
if [ "$HAS_SYSTEMD" -eq 1 ] && $SC is-active --quiet "$SERVICE_NAME.service"; then
  log "stopping running $SERVICE_NAME.service for upgrade"
  $SC stop "$SERVICE_NAME.service"
fi
fetch_appimage
extract_appimage
printf '%s\n' "$VERSION" >"$INSTALL_DIR/VERSION"
ensure_user
configure_sandbox
resolve_pairing_address
write_unit
log "installed Orca $VERSION to $INSTALL_DIR (service user: $SERVICE_USER, port: $PORT, pairing address: $PAIRING_ADDRESS)"

if [ "$HAS_SYSTEMD" -eq 0 ]; then
  log "systemd not detected; start the server in the foreground with:"
  log "  APPDIR=$INSTALL_DIR/squashfs-root HOME=$SERVICE_HOME LIBGL_ALWAYS_SOFTWARE=1 $INSTALL_DIR/squashfs-root/AppRun ${NO_SANDBOX_FLAG}serve --port $PORT --pairing-address $PAIRING_ADDRESS"
  exit 0
fi
if [ "$NO_START" -eq 1 ]; then
  log "--no-start given; enable later with: $SC enable --now $SERVICE_NAME.service"
  exit 0
fi
start_and_report
