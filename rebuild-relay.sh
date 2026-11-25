#!/usr/bin/env bash
# Rebuild the self-hosted Orca relay image from upstream source and deploy it
# to the relay host. Run after every desktop Orca update: the relay wire
# contract must be >= the desktop version, or the desktop gets assignments but
# never establishes its host control socket (metrics: controls:0, retry storm).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/sources/stablyai/orca}"
WORKTREE="${WORKTREE:-/tmp/orca-relay-build}"
IMAGE="${IMAGE:-ghcr.io/stablyai/relay:latest}"
SSH_HOST="${SSH_HOST:-tencent-cloud}"
COMPOSE_DIR="${COMPOSE_DIR:-/home/ubuntu/composes/orca-relay}"
RELAY_URL="${RELAY_URL:-https://orca-relay.cutiechi.com}"
PLATFORM="${PLATFORM:-linux/amd64}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"
CACHE_FILE="$HOME/Library/Application Support/Orca/orca-relay-region-preference.json"

TAG=""
DRY_RUN=0
VERIFY=1

usage() {
  cat <<'EOF'
Usage: rebuild-relay.sh [TAG] [--dry-run] [--no-verify] [--wait=N]

Rebuild the relay image from an upstream tag and deploy it to the relay host.

  TAG          build this release tag (default: latest vN.N.N release tag)
  --dry-run    resolve the tag and print the plan only, touch nothing
  --no-verify  skip waiting for the host control channel (controls >= 1)
  --wait=N     seconds to wait for controls (default 180)

Env overrides: REPO_DIR WORKTREE IMAGE SSH_HOST COMPOSE_DIR RELAY_URL PLATFORM
EOF
}

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-verify) VERIFY=0 ;;
    --wait=*) WAIT_SECONDS="${arg#--wait=}" ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $arg (see --help)" >&2; exit 1 ;;
    *) TAG="$arg" ;;
  esac
done

[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die "--wait/WAIT_SECONDS must be a number of seconds, got: $WAIT_SECONDS"

command -v git >/dev/null || die "git not found"
command -v docker >/dev/null || die "docker not found"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "no git repo at $REPO_DIR"

if [ -z "$TAG" ]; then
  say "resolving latest upstream release tag"
  TAG="$(git -C "$REPO_DIR" ls-remote --tags origin 'v*' 2>/dev/null \
    | sed -n 's#.*refs/tags/\(v[0-9][0-9.]*\)$#\1#p' \
    | sort -V | tail -1)"
  [ -n "$TAG" ] || die "could not resolve latest release tag"
fi

say "target tag: $TAG"
say "image: $IMAGE ($PLATFORM) -> $SSH_HOST:$COMPOSE_DIR"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: would fetch $TAG, build from cloud/, load on $SSH_HOST, compose up, verify $RELAY_URL"
  exit 0
fi

docker info >/dev/null 2>&1 || die "docker daemon is not running (start OrbStack/Docker)"

say "fetching $TAG"
git -C "$REPO_DIR" fetch --no-tags origin tag "$TAG"

COMMIT="$(git -C "$REPO_DIR" rev-parse --short "$TAG^{commit}")"
git -C "$REPO_DIR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
trap 'git -C "$REPO_DIR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true' EXIT
git -C "$REPO_DIR" worktree add "$WORKTREE" "$TAG" >/dev/null

say "building $TAG ($COMMIT) for $PLATFORM"
docker buildx build --platform "$PLATFORM" --load \
  -f "$WORKTREE/cloud/apps/relay/Dockerfile" \
  -t "$IMAGE" "$WORKTREE/cloud"

say "shipping image to $SSH_HOST"
docker save "$IMAGE" | gzip -1 | ssh "$SSH_HOST" 'gunzip | docker load'

say "restarting relay"
ssh "$SSH_HOST" "cd '$COMPOSE_DIR' && docker compose up -d"
ssh "$SSH_HOST" "printf '%s %s\n' '$TAG' '$COMMIT' > '$COMPOSE_DIR/.relay-source'"

say "waiting for $RELAY_URL/health"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "$RELAY_URL/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || die "relay /health did not come back within 60s"
curl -fsS --max-time 5 "$RELAY_URL/health"; echo

if [ "$VERIFY" = 0 ]; then
  say "deployed $TAG ($COMMIT); control-channel verification skipped"
  exit 0
fi

if [ -f "$CACHE_FILE" ]; then
  cache_director="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("directorUrl",""))' "$CACHE_FILE" 2>/dev/null || true)"
  if [ -n "$cache_director" ] && [ "$cache_director" != "$RELAY_URL" ]; then
    printf 'warning: desktop relay director is %s, not %s\n' "$cache_director" "$RELAY_URL" >&2
    printf 'warning: relaunch with: open -a Orca --env ORCA_RELAY_URL=%s\n' "$RELAY_URL" >&2
  fi
fi

say "waiting up to ${WAIT_SECONDS}s for host control channel (controls:1)"
controls=0
elapsed=0
while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
  controls="$(ssh "$SSH_HOST" "docker logs orca-relay --since 3m 2>&1 | grep -o '\"controls\":[0-9]*' | tail -1 | cut -d: -f2" 2>/dev/null || echo 0)"
  [ -n "$controls" ] || controls=0
  [ "$controls" -ge 1 ] && break
  sleep 5
  elapsed=$((elapsed + 5))
done

ssh "$SSH_HOST" "docker logs -t orca-relay --since 10m 2>&1 | grep -E 'assignment granted|host_control_rtt|control closed' | tail -5" || true

if [ "$controls" -ge 1 ]; then
  say "done: relay $TAG ($COMMIT) live, controls=$controls"
  exit 0
fi

printf 'deployed %s (%s) but controls never reached 1 within %ss.\n' "$TAG" "$COMMIT" "$WAIT_SECONDS" >&2
printf 'check: desktop Orca version >= relay version, and it was launched with ORCA_RELAY_URL=%s\n' "$RELAY_URL" >&2
exit 2
