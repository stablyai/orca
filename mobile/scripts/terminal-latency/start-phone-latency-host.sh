#!/usr/bin/env bash
# Starts the host the phone latency matrix measures against: a Docker container running an Orca
# server at its own IP with three terminals (Claude Code, Codex, less). Prints the pairing link.
#
# Usage: start-phone-latency-host.sh <orca-linux-arm64.AppImage> [container-name]
#
# Needs OrbStack (it routes container IPs from the Mac; Docker Desktop does not). The AppImage is
# a Linux Orca release: `gh release download --repo stablyai/orca --pattern orca-linux-arm64.AppImage`.
set -euo pipefail

APPIMAGE="$(cd "$(dirname "${1:?AppImage path required}")" && pwd)/$(basename "$1")"
CONTAINER="${2:-orca-phone-host}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE="$ROOT/tests/e2e/fixtures/agent-terminal-host"
# Why hash contents: a tar stream carries mtimes, so it would rebuild the image on every checkout.
IMAGE="orca-e2e-agent-terminal-host:$(cd "$FIXTURE" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)"
WORK="${TMPDIR:-/tmp}/$CONTAINER"

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$FIXTURE" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
mkdir -p "$WORK"
rm -f "$WORK/serve.out"
docker run -d --name "$CONTAINER" -v "$APPIMAGE:/artifacts/orca.AppImage:ro" -v "$WORK:/work" \
  --shm-size=1g "$IMAGE" sleep infinity >/dev/null
IP="$(docker inspect "$CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
docker exec -u root "$CONTAINER" chown agent:agent /work
# Why the pairing address: the phone must connect to the container's own IP, never a published
# port, or its connection ends at Docker's forwarder and sees a perfect link.
docker exec -d "$CONTAINER" bash -lc "cd /home/agent && xvfb-run -a /artifacts/orca.AppImage \
  --appimage-extract-and-run --no-sandbox serve --port 6800 --pairing-address $IP --mobile-pairing \
  --json > /work/serve.out 2>&1"
for _ in $(seq 1 60); do grep -q '^{' "$WORK/serve.out" 2>/dev/null && break; sleep 2; done
grep -q '^{' "$WORK/serve.out" || { echo "server did not start; see $WORK/serve.out" >&2; exit 1; }

docker exec "$CONTAINER" bash -lc '
  export PATH=$HOME/.local/bin:$PATH
  mkdir -p /tmp/agent-stub
  echo "{\"total_lines\":300,\"chars_per_second\":6000}" > /tmp/agent-stub/config.json
  orca repo add --path /home/agent/demo-repo --json >/dev/null
  create() { orca terminal create --worktree path:/home/agent/demo-repo --title "$1" --json | jq -r .result.terminal.handle; }
  c=$(create claude); x=$(create codex); p=$(create pager)
  orca terminal send --terminal "$c" --text "/opt/agent-terminal-host/run-claude.sh \"warm up\"" --enter --json >/dev/null
  orca terminal send --terminal "$x" --text "/opt/agent-terminal-host/run-codex.sh \"warm up\"" --enter --json >/dev/null
  orca terminal send --terminal "$p" --text "less /home/agent/lines.txt" --enter --json >/dev/null
  sleep 30
  echo "{\"total_lines\":40,\"chars_per_second\":400}" > /tmp/agent-stub/config.json
'
echo "container: $CONTAINER at $IP"
echo "pairing link (open it on the simulator with: xcrun simctl openurl <udid> '<link>'):"
grep '^{' "$WORK/serve.out" | head -1 | jq -r '.. | strings | select(startswith("orca://pair"))' | head -1
