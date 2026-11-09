#!/usr/bin/env bash
# Runs once inside the build sandbox (as the sandbox user, with sudo). Installs the pinned orcad
# bundle, agent CLIs and Orca's VM entry points into /opt/orca, then smoke-tests orcad.
# Inputs (env, from image/golden-image.manifest.json via build-golden-image.ts):
#   ORCAD_BUNDLE_URL ORCAD_BUNDLE_SHA256 [GH_VERSION GH_SHA256] AGENT_NPM_PACKAGES (space-separated
#   name@version) and ORCA_VM_SCRIPT_<name> (base64) for each /opt/orca/bin entry point.
set -euo pipefail
ORCA_HOME=/opt/orca
log() { printf '[golden] %s\n' "$*" >&2; }

sudo mkdir -p "$ORCA_HOME/bin" "$ORCA_HOME/runtime" "$ORCA_HOME/tools"
sudo chown -R "$(id -u):$(id -g)" "$ORCA_HOME"

log 'system packages'
if command -v apt-get >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git jq ripgrep build-essential python3 unzip util-linux procps >/dev/null
elif command -v dnf >/dev/null; then
  sudo dnf install -y -q ca-certificates curl-minimal git jq gcc gcc-c++ make python3 unzip util-linux procps-ng >/dev/null
else
  log 'no supported package manager'; exit 1
fi

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

log 'agent CLIs'
# The image's system npm installs them; agents later run on whatever node orcad puts on PATH.
# shellcheck disable=SC2086 # word splitting is the package list
npm install --global --no-fund --no-audit --prefix "$ORCA_HOME/tools" $AGENT_NPM_PACKAGES

log 'Orca entry points'
for name in orca-sandbox-start orca-sandbox-drain orca-egress-probe orca-image-wipe; do
  var="ORCA_VM_SCRIPT_${name//-/_}"
  printf '%s' "${!var}" | base64 -d >"$ORCA_HOME/bin/$name"
  chmod 0755 "$ORCA_HOME/bin/$name"
done
printf 'export PATH=%s/tools/bin:%s/bin:$PATH\n' "$ORCA_HOME" "$ORCA_HOME" | sudo tee /etc/profile.d/orca.sh >/dev/null
sudo chown -R root:root "$ORCA_HOME"

log 'smoke: orcad reaches ready on loopback'
smoke_data="$(mktemp -d)"
ORCA_USER_DATA="$smoke_data" timeout 60 "$node" "$ORCA_HOME/runtime/orcad/orcad-server.js" \
  --port 6799 --json >/tmp/orcad-smoke.out 2>/tmp/orcad-smoke.err &
smoke_pid=$!
ready=0
for _ in $(seq 1 600); do
  if grep -q '"orca_server_ready"' /tmp/orcad-smoke.out 2>/dev/null; then ready=1; break; fi
  sleep 0.1
done
kill "$smoke_pid" 2>/dev/null || true
wait "$smoke_pid" 2>/dev/null || true
rm -rf "$smoke_data" /tmp/orcad-smoke.out
if [ "$ready" != 1 ]; then
  tail -n 40 /tmp/orcad-smoke.err >&2; exit 1
fi

log 'versions'
versions="{}"
for bin in claude codex opencode gemini gh; do
  if [ -x "$ORCA_HOME/tools/bin/$bin" ]; then
    v="$("$ORCA_HOME/tools/bin/$bin" --version 2>/dev/null | head -n 1 || echo unknown)"
    versions="$(jq -c --arg k "$bin" --arg v "$v" '. + {($k): $v}' <<<"$versions")"
  fi
done
jq -c --arg node "$("$node" --version)" '{node: $node, tools: .}' <<<"$versions"
