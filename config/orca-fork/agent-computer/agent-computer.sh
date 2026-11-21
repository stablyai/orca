#!/usr/bin/env bash
# orca-fork: shared agent computer for one machine (docs/fork/agent-computer.md).
# One Xtigervnc display with an XFCE session on a 0600 Unix socket (no TCP VNC port), noVNC served
# by websockify on 127.0.0.1 only. Agents on this machine share it through DISPLAY and the MCP server.
set -euo pipefail

DISPLAY_NUM="${ORCA_COMPUTER_DISPLAY:-42}"
WEB_PORT="${ORCA_COMPUTER_WEB_PORT:-6080}"
GEOMETRY="${ORCA_COMPUTER_GEOMETRY:-1440x900}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/orca-fork/agent-computer"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/orca-fork/agent-computer"
UNIT_NAME="orca-agent-computer.service"
SOCKET="$STATE_DIR/vnc.sock"
PASSWD_FILE="$STATE_DIR/passwd"
NOVNC_DIR="${ORCA_COMPUTER_NOVNC_DIR:-/usr/share/novnc}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APT_PACKAGES=(tigervnc-standalone-server tigervnc-tools xfce4 xfce4-terminal dbus-x11 novnc
  python3-websockify xdotool scrot xclip)

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>
  install     install packages, copy files to $INSTALL_DIR, enable the user service, register the MCP server
  uninstall   stop and remove the user service and the MCP registration
  run         run the desktop in the foreground (what the service runs)
  status      show whether the desktop is up, its DISPLAY, the viewer URL and the password
  env         print the environment agents need (eval "\$(... env)")
Environment: ORCA_COMPUTER_DISPLAY (42) ORCA_COMPUTER_WEB_PORT (6080) ORCA_COMPUTER_GEOMETRY (1440x900)
EOF
}

ensure_password() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [[ ! -s "$PASSWD_FILE" ]]; then
    # VncAuth uses only the first 8 characters.
    head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8 >"$STATE_DIR/password"
    chmod 600 "$STATE_DIR/password"
    vncpasswd -f <"$STATE_DIR/password" >"$PASSWD_FILE"
    chmod 600 "$PASSWD_FILE"
  fi
}

run() {
  ensure_password
  rm -f "$SOCKET" "/tmp/.X11-unix/X$DISPLAY_NUM" "/tmp/.X$DISPLAY_NUM-lock"
  local pids=()
  cleanup() {
    kill "${pids[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  Xtigervnc ":$DISPLAY_NUM" -geometry "$GEOMETRY" -depth 24 -rfbport -1 \
    -rfbunixpath "$SOCKET" -rfbunixmode 0600 -SecurityTypes VncAuth -PasswordFile "$PASSWD_FILE" \
    -AlwaysShared -AcceptSetDesktopSize=1 -nolisten tcp &
  pids+=($!)
  for _ in $(seq 1 50); do
    [[ -S "/tmp/.X11-unix/X$DISPLAY_NUM" && -S "$SOCKET" ]] && break
    sleep 0.1
  done

  DISPLAY=":$DISPLAY_NUM" dbus-launch --exit-with-session startxfce4 >"$STATE_DIR/xfce.log" 2>&1 &
  pids+=($!)
  websockify --web "$NOVNC_DIR" "127.0.0.1:$WEB_PORT" --unix-target="$SOCKET" \
    >"$STATE_DIR/websockify.log" 2>&1 &
  pids+=($!)
  echo "agent computer up: DISPLAY=:$DISPLAY_NUM viewer http://127.0.0.1:$WEB_PORT/vnc.html"
  wait -n "${pids[@]}"
}

status() {
  local up=no
  [[ -S "/tmp/.X11-unix/X$DISPLAY_NUM" ]] && xdpyinfo_ok && up=yes
  echo "running:  $up"
  echo "DISPLAY:  :$DISPLAY_NUM"
  echo "viewer:   http://127.0.0.1:$WEB_PORT/vnc.html?autoconnect=1&resize=remote"
  echo "tunnel:   ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT $(whoami)@<this-host>"
  [[ -s "$STATE_DIR/password" ]] && echo "password: $(cat "$STATE_DIR/password")"
  if command -v systemctl >/dev/null; then
    echo "service:  $(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
  fi
}

xdpyinfo_ok() {
  DISPLAY=":$DISPLAY_NUM" xdotool getdisplaygeometry >/dev/null 2>&1
}

install() {
  local missing=()
  for pkg in "${APT_PACKAGES[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
  mkdir -p "$INSTALL_DIR"
  cp "$SCRIPT_DIR/agent-computer.sh" "$SCRIPT_DIR/agent-computer-mcp.mjs" "$INSTALL_DIR/"
  chmod +x "$INSTALL_DIR/agent-computer.sh"

  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/$UNIT_NAME" <<EOF
[Unit]
Description=Orca shared agent computer (DISPLAY=:$DISPLAY_NUM)

[Service]
Environment=ORCA_COMPUTER_DISPLAY=$DISPLAY_NUM ORCA_COMPUTER_WEB_PORT=$WEB_PORT ORCA_COMPUTER_GEOMETRY=$GEOMETRY
ExecStart=$INSTALL_DIR/agent-computer.sh run
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  # Survive logout so the desktop and agents keep it while nobody is connected.
  loginctl enable-linger "$(whoami)" 2>/dev/null || true

  local node_bin
  node_bin="$(readlink -f "$(command -v node)")"
  if command -v claude >/dev/null; then
    claude mcp remove --scope user agent-computer >/dev/null 2>&1 || true
    claude mcp add --scope user agent-computer -e "DISPLAY=:$DISPLAY_NUM" -- \
      "$node_bin" "$INSTALL_DIR/agent-computer-mcp.mjs"
  fi
  if command -v codex >/dev/null; then
    codex mcp remove agent-computer >/dev/null 2>&1 || true
    codex mcp add agent-computer --env "DISPLAY=:$DISPLAY_NUM" -- \
      "$node_bin" "$INSTALL_DIR/agent-computer-mcp.mjs" || true
  fi
  echo "MCP server: $node_bin $INSTALL_DIR/agent-computer-mcp.mjs (env DISPLAY=:$DISPLAY_NUM)"
  sleep 2
  status
}

uninstall() {
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
  systemctl --user daemon-reload || true
  command -v claude >/dev/null && claude mcp remove --scope user agent-computer || true
  command -v codex >/dev/null && codex mcp remove agent-computer || true
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  run) run ;;
  status) status ;;
  env) echo "export DISPLAY=:$DISPLAY_NUM" ;;
  *) usage; exit 2 ;;
esac
