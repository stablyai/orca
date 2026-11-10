#!/usr/bin/env bash
# Runs once inside the build sandbox (as the sandbox user, with sudo). Installs the pinned orcad
# bundle, agent CLIs and Orca's VM entry points into /opt/orca, then smoke-tests orcad.
# Inputs (env, from image/golden-image.manifest.json via build-golden-image.ts):
#   ORCAD_BUNDLE_URL ORCAD_BUNDLE_SHA256 [GH_VERSION GH_SHA256] [CHROME_VERSION CHROME_SHA256]
#   AGENT_NPM_PACKAGES (space-separated
#   name@version), [NOVNC_VERSION NOVNC_SHA256 WEBSOCKIFY_VERSION WEBSOCKIFY_SHA256] and ORCA_VM_SCRIPT_<name> (base64) for each /opt/orca/bin entry point.
set -euo pipefail
ORCA_HOME=/opt/orca
log() { printf '[golden] %s\n' "$*" >&2; }

sudo mkdir -p "$ORCA_HOME/bin" "$ORCA_HOME/runtime" "$ORCA_HOME/tools"
sudo chown -R "$(id -u):$(id -g)" "$ORCA_HOME"

log 'system packages'
if command -v apt-get >/dev/null; then
  # Transient mirror errors and dpkg lock contention made apt exit 100 (2 of ~10 golden builds):
  # retry downloads and wait for the lock instead of failing the build.
  printf 'Acquire::Retries "5";\nDPkg::Lock::Timeout "180";\n' | sudo tee /etc/apt/apt.conf.d/80-orca-retries >/dev/null
  # Sandbox egress is TLS-only: plain-http apt mirrors time out at runtime (W2, wake on SSH).
  sudo sed -i 's#http://#https://#g' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  # Developer basics agents expect (Conductor parity): rg, tmux, vim, git-lfs alongside the build tools.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git git-lfs jq ripgrep tmux vim-nox less openssh-client openssh-server build-essential python3 \
    unzip zip util-linux procps >/dev/null
  git lfs install --system --skip-repo >/dev/null
  # sshd is started on demand by the wake-on-SSH bridge (key-only, loopback); never at boot.
  sudo systemctl disable ssh.service ssh.socket >/dev/null 2>&1 || true
  # A locked password field ("!") makes sshd refuse even key logins; '*' = no password, not locked.
  sudo usermod -p '*' "$(id -un)"
elif command -v dnf >/dev/null; then
  sudo dnf install -y -q ca-certificates curl-minimal git git-lfs jq tmux vim-enhanced gcc gcc-c++ make python3 \
    unzip util-linux procps-ng >/dev/null
else
  log 'no supported package manager'; exit 1
fi

# Managed images have no /vercel/sandbox; the project lives at /vercel/sandbox/project on every image.
sudo install -d -o "$(id -u)" -g "$(id -g)" /vercel/sandbox

fetch_verified() { # url sha256 dest
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

log 'orcad bundle'
bundle="$(mktemp -d)/orcad.tgz"
fetch_verified "$ORCAD_BUNDLE_URL" "$ORCAD_BUNDLE_SHA256" "$bundle"
tar -xzf "$bundle" -C "$ORCA_HOME/runtime"
rm -rf "$(dirname "$bundle")"
# Release tarballs (orca-server-linux-*) may nest the server; normalize to runtime/orcad + runtime/runtimes.
if [ ! -s "$ORCA_HOME/runtime/orcad/orcad-server.js" ]; then
  server="$(find "$ORCA_HOME/runtime" -name orcad-server.js -type f | head -n 1)"
  [ -n "$server" ] || { log 'bundle has no orcad-server.js'; exit 1; }
  root="$(dirname "$(dirname "$server")")"
  ln -sfn "$(dirname "$server")" "$ORCA_HOME/runtime/orcad"
  [ -d "$ORCA_HOME/runtime/runtimes" ] || ln -sfn "$root/runtimes" "$ORCA_HOME/runtime/runtimes"
fi
test -s "$ORCA_HOME/runtime/orcad/orcad-server.js"
node="$(find "$ORCA_HOME/runtime/runtimes" -type f -name node | head -n 1)"
test -x "$node"

if [ -n "${GH_VERSION:-}" ]; then
  log "gh $GH_VERSION"
  fetch_verified "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    "$GH_SHA256" /tmp/gh.tgz
  tar -xzf /tmp/gh.tgz -C /tmp
  mkdir -p "$ORCA_HOME/tools/bin"
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" "$ORCA_HOME/tools/bin/gh"
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"
fi

if [ -n "${CHROME_VERSION:-}" ] && command -v apt-get >/dev/null; then
  log "google-chrome $CHROME_VERSION (headless browser for agents and Orca browser automation)"
  deb="$(mktemp -d)/chrome.deb"
  fetch_verified "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
    "$CHROME_SHA256" "$deb"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$deb" >/dev/null
  rm -rf "$(dirname "$deb")"
  # The .deb adds Google's apt source; the image stays pinned, so drop it.
  sudo rm -f /etc/apt/sources.list.d/google-chrome.list /etc/cron.daily/google-chrome
  google-chrome --headless=new --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>ok</p>' 2>/dev/null | grep -q '<p>ok</p>'
fi

log 'agent CLIs'
# The image's system npm installs them; agents later run on whatever node orcad puts on PATH.
# shellcheck disable=SC2086 # word splitting is the package list
npm install --global --no-fund --no-audit --prefix "$ORCA_HOME/tools" $AGENT_NPM_PACKAGES

log 'openssh server (binaries only)'
# For `orca ssh`: an unprivileged sshd on loopback (see vm/orca-sshd). Only the server binaries,
# kept out of /usr: the packages would pull in systemd units, SELinux policy (~38 MB on AL2023) and
# system host keys a user-run sshd never uses. Its libraries are already in the base image, except
# tcp-wrappers on Ubuntu.
mkdir -p "$ORCA_HOME/openssh"
pkgs="$(mktemp -d)"
if command -v dnf >/dev/null; then
  sudo dnf install -y -q --setopt=install_weak_deps=False cpio >/dev/null
  sudo dnf install -y -q --downloadonly --downloaddir="$pkgs" openssh-server >/dev/null
  (cd "$pkgs" && rpm2cpio openssh-server-[0-9]*.rpm | cpio -idm --quiet)
  sudo dnf clean all -q >/dev/null 2>&1 || true
  libexec="$pkgs/usr/libexec/openssh"
else
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libwrap0 >/dev/null
  (cd "$pkgs" && apt-get download -qq openssh-server openssh-sftp-server >/dev/null)
  for deb in "$pkgs"/*.deb; do dpkg-deb -x "$deb" "$pkgs"; done
  libexec="$pkgs/usr/lib/openssh"
fi
install -m 0755 "$pkgs/usr/sbin/sshd" "$libexec/sshd-session" "$libexec/sftp-server" "$ORCA_HOME/openssh/"
# OpenSSH 10 splits authentication into its own binary.
if [ -x "$libexec/sshd-auth" ]; then install -m 0755 "$libexec/sshd-auth" "$ORCA_HOME/openssh/"; fi
sudo rm -rf "$pkgs"
"$ORCA_HOME/openssh/sshd" -V 2>&1 | head -n 1 >&2 || true
# sshd refuses a locked account ('!') even for key logins; '*' unlocks it with no usable password.
sudo usermod -p '*' "$(id -un)"

install_desktop() {
  # Remote desktop (~80 MB): Xvnc + openbox + xterm from the distro, noVNC + websockify pinned
  # tarballs. Only orca-desktop-start runs it, on demand; nothing starts at boot. Every step says
  # `|| return 1`: errexit does not apply inside an `if` condition.
  command -v apt-get >/dev/null || { log 'remote desktop: apt only'; return 1; }
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    tigervnc-standalone-server tigervnc-tools openbox xterm x11-xserver-utils >/dev/null || return 1
  local tmp dir="$ORCA_HOME/desktop"
  tmp="$(mktemp -d)" || return 1
  fetch_verified "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
    "$NOVNC_SHA256" "$tmp/novnc.tgz" || return 1
  fetch_verified "https://github.com/novnc/websockify/archive/refs/tags/v${WEBSOCKIFY_VERSION}.tar.gz" \
    "$WEBSOCKIFY_SHA256" "$tmp/websockify.tgz" || return 1
  rm -rf "$dir" && mkdir -p "$dir/novnc" "$dir/websockify" || return 1
  tar -xzf "$tmp/novnc.tgz" -C "$dir/novnc" --strip-components 1 || return 1
  tar -xzf "$tmp/websockify.tgz" -C "$dir/websockify" --strip-components 1 || return 1
  # Orca tab fit: title "Remote desktop" (Xvnc's -desktop name), no noVNC favicon, control bar on
  # the right (away from Orca's sidebar edge); a stale per-boot password ends the session with one
  # plain message instead of a reconnect loop. "Unencrypted" is noVNC's view of plain ws:// to
  # localhost; the hop to the sandbox rides the end-to-end encrypted runtime connection.
  sed -i -e 's/document.title = e.detail.name + " - " + PAGE_TITLE;/document.title = e.detail.name;/' \
    -e "s/WebUtil.readSetting('controlbar_pos') === 'right'/WebUtil.readSetting('controlbar_pos', 'right') === 'right'/" \
    -e 's/securityFailed(e) {/securityFailed(e) { UI.inhibitReconnect = true; UI.showStatus("This remote desktop session ended. Reopen it from the workspace menu.", "error"); return;/' \
    -e 's/_("Connected (unencrypted) to ")/_("Connected to ")/' \
    "$dir/novnc/app/ui.js" || return 1
  sed -i '/rel="icon"/d; /rel="apple-touch-icon"/d' "$dir/novnc/vnc.html" || return 1
  rm -rf "$tmp"
  PYTHONPATH="$dir/websockify" python3 -P -c 'import websockify' >/dev/null || return 1
  command -v Xvnc >/dev/null && test -s "$dir/novnc/vnc.html"
}
desktop=false
if [ -n "${NOVNC_VERSION:-}" ]; then
  log 'remote desktop'
  # Optional: a failure leaves an image without the desktop, never a failed build.
  if install_desktop; then
    desktop=true
  else
    log 'remote desktop install failed; continuing without it'
    rm -rf "$ORCA_HOME/desktop"
  fi
fi

log 'Orca entry points'
for name in orca-sandbox-start orca-sandbox-drain orca-sandbox-env orca-session-env.sh orca-egress-probe orca-image-wipe orca-share-proxy orca-sshd orca-ssh-keys orca-desktop-start orca-desktop-proxy orca-desktop-page.js orca-sandbox-grant orca-sandbox-revoke orca-sandbox-members orca-git-as orca-git-identity orcad-boot git; do
  var="ORCA_VM_SCRIPT_${name//[-.]/_}"
  printf '%s' "${!var}" | base64 -d >"$ORCA_HOME/bin/$name"
  chmod 0755 "$ORCA_HOME/bin/$name"
done
# The orca CLI (agents drive worktrees, terminals and the browser through it) talks to this VM's orcad.
cli="$(find "$ORCA_HOME/runtime" -name orca-cli.cjs -type f | head -n 1)"
if [ -n "$cli" ]; then
  printf '#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH="${ORCA_USER_DATA_PATH:-$HOME/.orcad-data}"\nexec "%s" "%s" "$@"\n' "$node" "$cli" >"$ORCA_HOME/bin/orca"
  chmod 0755 "$ORCA_HOME/bin/orca"
else
  log 'bundle has no orca CLI (orca-cli.cjs): agents will not have `orca` on PATH'
fi
# The image's node/npm/npx live only on the build command's PATH; append them so agents (codex's
# `env node` shebang) and stdio MCP servers launched with npx resolve them in Orca's login shells.
system_node="$(command -v npx || command -v node || true)"
if [ -z "$system_node" ]; then
  echo 'no node/npx on the build PATH' >&2
  exit 1
fi
printf 'export PATH=%s/tools/bin:%s/bin:$PATH:%s\n' "$ORCA_HOME" "$ORCA_HOME" "$(dirname "$system_node")" |
  sudo tee /etc/profile.d/orca.sh >/dev/null
# Every new shell (login or not: /etc/bashrc sources profile.d) re-reads the session env file.
sudo install -m 0644 "$ORCA_HOME/bin/orca-session-env.sh" /etc/profile.d/zz-orca-session-env.sh
if [ -f /etc/bash.bashrc ]; then
  # Ubuntu's bash.bashrc does not source profile.d for non-login interactive shells (AL2023's bashrc does).
  grep -q zz-orca-session-env /etc/bash.bashrc ||
    echo '[ -r /etc/profile.d/zz-orca-session-env.sh ] && . /etc/profile.d/zz-orca-session-env.sh' | sudo tee -a /etc/bash.bashrc >/dev/null
fi
sudo chown -R root:root "$ORCA_HOME"

log 'smoke: orcad reaches ready on loopback (and warms the V8 compile cache: ~1.5 s off every boot)'
sudo install -d -o "$(id -u)" -g "$(id -g)" "$ORCA_HOME/compile-cache"
# The runtime is root-owned, so its startup-qualified marker lives here. The smoke run leaves one,
# so every boot from the image skips orcad's disposable startup preflight (~0.6 s of wake).
sudo install -d -o "$(id -u)" -g "$(id -g)" "$ORCA_HOME/startup-qualification"
smoke_data="$(mktemp -d)"
# orcad-boot also writes orcad's full code cache as the smoke run exits (~0.3 s more off every boot).
NODE_COMPILE_CACHE="$ORCA_HOME/compile-cache" ORCA_ORCAD_STARTUP_QUALIFICATION_DIR="$ORCA_HOME/startup-qualification" \
  ORCA_USER_DATA="$smoke_data" timeout 60 "$node" "$ORCA_HOME/bin/orcad-boot" \
  --code-cache "$ORCA_HOME/compile-cache/orcad-server.v8" --write-code-cache "$ORCA_HOME/runtime/orcad/orcad-server.js" \
  --port 6799 --json >/tmp/orcad-smoke.out 2>/tmp/orcad-smoke.err &
smoke_pid=$!
ready=0
for _ in $(seq 1 600); do
  if grep -q '"orca_server_ready"' /tmp/orcad-smoke.out 2>/dev/null; then ready=1; break; fi
  sleep 0.1
done
# orcad writes the marker just after readiness; best effort, a boot without one only re-qualifies.
for _ in $(seq 1 30); do
  [ "$ready" = 1 ] && [ ! -s "$ORCA_HOME/startup-qualification/.orcad-startup-qualified" ] || break
  sleep 0.1
done
kill "$smoke_pid" 2>/dev/null || true
wait "$smoke_pid" 2>/dev/null || true
rm -rf "$smoke_data" /tmp/orcad-smoke.out
if [ "$ready" != 1 ]; then
  tail -n 40 /tmp/orcad-smoke.err >&2; exit 1
fi
# Best effort: without it every boot loads orcad as before.
if [ -s "$ORCA_HOME/compile-cache/orcad-server.v8" ]; then
  log "orcad code cache: $(stat -c %s "$ORCA_HOME/compile-cache/orcad-server.v8") bytes"
else
  log 'orcad code cache was not written; boots compile orcad without it'
  grep 'orcad-boot' /tmp/orcad-smoke.err >&2 || true
fi

log 'versions'
versions="{}"
for bin in claude codex opencode gemini gh; do
  if [ -x "$ORCA_HOME/tools/bin/$bin" ]; then
    v="$("$ORCA_HOME/tools/bin/$bin" --version 2>/dev/null | head -n 1 || echo unknown)"
    versions="$(jq -c --arg k "$bin" --arg v "$v" '. + {($k): $v}' <<<"$versions")"
  fi
done
for sys in rg vim git-lfs google-chrome; do
  if command -v "$sys" >/dev/null; then
    v="$("$sys" --version 2>/dev/null | head -n 1 || echo unknown)"
    versions="$(jq -c --arg k "$sys" --arg v "$v" '. + {($k): $v}' <<<"$versions")"
  fi
done
command -v tmux >/dev/null && versions="$(jq -c --arg v "$(tmux -V)" '. + {tmux: $v}' <<<"$versions")"
[ -x "$ORCA_HOME/bin/orca" ] && versions="$(jq -c '. + {orca: "bundled"}' <<<"$versions")"
jq -c --arg node "$("$node" --version)" --arg disk "$(df -h / | awk 'NR==2{print $2}')" \
  --argjson desktop "$desktop" '{node: $node, disk: $disk, tools: ., desktop: $desktop}' <<<"$versions"
