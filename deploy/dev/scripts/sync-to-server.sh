#!/usr/bin/env bash
# ============================================================
# sync-to-server.sh — rsync built binaries + run migrations + start stack
# ============================================================
# Step 2+3 of the deploy flow:
#   (1) build binary locally  →  (2) sync to server  →  (3) mount into container
#
# Unlike deploy/old/scripts/sync-to-server-artifact.sh, there is NO
# `docker compose build` step here at all — every image except one
# (gcr.io/distroless/static-debian12, nginx:1.27-alpine, postgres:16-alpine,
# nats, migrate/migrate) is public and unmodified; the
# server only needs `docker compose pull` (cached after the first run) and
# the rsynced binaries/static assets bind-mounted in. This is what makes
# redeploys fast: no server-side compile, no server-side image build. The
# one exception is git-gateway-service's own small runtime image (needs a
# real `git` binary — see docker-compose.yml's comment on that service) —
# built locally by build-local.sh, never on a registry, so it's transferred
# via `docker save | ssh docker load` (step 3 below) instead of a pull.
#
# Usage:
#   ./deploy/dev/scripts/sync-to-server.sh <version>
# Example:
#   ./deploy/dev/scripts/sync-to-server.sh 0.1.0
# ============================================================

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "ERROR: Version argument is required to prevent accidental untracked deployments."
    echo "Usage: $0 <version>"
    exit 1
fi
ORCA_GO_VERSION="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/../.." && pwd)"

if [ -f "${DEPLOY_DIR}/.env" ]; then
    export $(grep -v '^#' "${DEPLOY_DIR}/.env" | xargs)
fi

SERVER_HOST="${SERVER_HOST:?ERROR: SERVER_HOST not set — see .env.example}"
SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_KEY="${SERVER_KEY:-${HOME}/.ssh/id_ed25519}"
SERVER_PORT="${SERVER_PORT:-22}"
SERVER_DEPLOY="${SERVER_DEPLOY:-~/orca-go-deploy}"

echo "======================================================"
echo " Orca backend-go — Sync & Deploy (mount-based, artifact mode)"
echo "======================================================"
echo "  Server:  ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT}"
echo "  Deploy:  ${SERVER_DEPLOY}"
echo "  Version: ${ORCA_GO_VERSION}"
echo "======================================================"
echo ""

SSH_OPTS="-i ${SERVER_KEY} -p ${SERVER_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
ssh_cmd() { ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "$@"; }
rsync_cmd() { rsync -avz --progress -e "ssh ${SSH_OPTS}" "$@"; }

echo "[pre] Testing SSH connection..."
ssh_cmd "echo '✅ Connected to \$(hostname)'"
echo ""

echo "[1/6] Building backend-go binaries + frontend LOCALLY..."
ORCA_GO_VERSION="${ORCA_GO_VERSION}" bash "${SCRIPT_DIR}/build-local.sh"
echo ""

if [ ! -f "${DEPLOY_DIR}/bin/usage-service/orca" ]; then
    echo "❌ ERROR: build output missing (deploy/dev/bin/usage-service/orca) — aborting."
    exit 1
fi
if [ ! -d "${DEPLOY_DIR}/dist" ]; then
    echo "❌ ERROR: frontend build output missing (deploy/dev/dist/) — aborting."
    exit 1
fi

echo "[2/6] Syncing binaries + migrations + frontend + deploy config to server..."
ssh_cmd "mkdir -p ${SERVER_DEPLOY}"

# Binaries + per-service migrations (small — SQL files + a handful of ~10MB
# static Go binaries, nowhere near "the source tree").
rsync_cmd --delete "${DEPLOY_DIR}/bin/" "${SERVER_USER}@${SERVER_HOST}:${SERVER_DEPLOY}/bin/"

# Frontend static build.
rsync_cmd --delete "${DEPLOY_DIR}/dist/" "${SERVER_USER}@${SERVER_HOST}:${SERVER_DEPLOY}/dist/"

# Deploy config itself (compose file, nginx conf, scripts, postgres init) —
# excludes .env (synced separately below, never overwritten blindly) and
# bin/dist (already synced above with --delete, don't re-walk them here).
rsync_cmd --delete \
    --exclude '.env' \
    --exclude 'bin/' \
    --exclude 'dist/' \
    "${DEPLOY_DIR}/" \
    "${SERVER_USER}@${SERVER_HOST}:${SERVER_DEPLOY}/"

# .env: only push if the server doesn't have one yet — never silently
# overwrite server-side secrets (VAULT_TOKEN, POSTGRES_PASSWORD, ...) with
# whatever's in the local working copy.
if ! ssh_cmd "test -f ${SERVER_DEPLOY}/.env"; then
    echo "  (no .env on server yet — pushing local one; edit it on the server after this)"
    rsync_cmd "${DEPLOY_DIR}/.env" "${SERVER_USER}@${SERVER_HOST}:${SERVER_DEPLOY}/.env"
else
    echo "  (server already has .env — leaving it untouched)"
fi

echo "✅ Synced"
echo ""

# git-gateway-service's own runtime image (built by build-local.sh, needs a
# real `git` binary — see docker-compose.yml's comment) isn't on any
# registry, so `docker compose pull` can never fetch it — transfer it the
# same no-registry way this whole deploy flow already avoids one:
# docker save | ssh docker load, straight over the same SSH connection
# everything else here uses.
echo "[3/6] Transferring git-gateway-service's runtime image to server..."
docker save "orca-git-gateway-runtime:${ORCA_GO_VERSION}" | \
    ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "docker load"
echo "✅ Transferred"
echo ""

echo "[4/6] Pulling public images on server (cached after first run)..."
# Best-effort: every image here is a pinned tag (postgres:16-alpine,
# nats:2.10-alpine, nginx:1.27-alpine via the frontend service) that's
# already cached on the server after the first successful deploy — a
# transient registry hiccup (live-verified twice, 2026-08-29: "TLS handshake
# timeout" against registry-1.docker.io) shouldn't abort an otherwise-ready
# deploy. `|| true` degrades to the already-cached local image; a genuinely
# NEW pinned tag (edited in this compose file) would still need a real pull
# to succeed at least once. No local vault image here (2026-09-07) — Vault
# is the shared vnp-domain instance now, see docker-compose.yml's
# x-go-common-env comment and ../VAULT-SHARED-MIGRATION.md.
ssh_cmd "cd ${SERVER_DEPLOY} && docker compose pull postgres nats frontend" || \
    echo "⚠️  Image pull failed (registry hiccup?) — continuing with whatever's already cached on the server."
echo ""

echo "[5/6] Running migrations (profile: migrate) for every DB-owning service..."
ssh_cmd "cd ${SERVER_DEPLOY} && docker compose up -d postgres nats && sleep 5"
bash "${SCRIPT_DIR}/migrate.sh" --remote
echo ""

echo "[6/6] Starting/recreating the full stack..."
# ORCA_GO_VERSION is passed inline, not via the server's .env (which this
# script deliberately never overwrites once it exists — see step 2 above):
# docker-compose.yml's git-gateway-service image tag
# (orca-git-gateway-runtime:${ORCA_GO_VERSION:-dev}) must resolve to the
# exact tag step 3 just `docker load`-ed on this same run.
ssh_cmd "cd ${SERVER_DEPLOY} && ORCA_GO_VERSION=${ORCA_GO_VERSION} docker compose up -d --force-recreate --remove-orphans"
echo ""

echo "Health check (waiting 15s for startup)..."
sleep 15
if ssh_cmd "docker exec orca-go-frontend wget -qO- http://127.0.0.1:8080/healthz" 2>/dev/null | grep -q "ok"; then
    echo "✅ Frontend health check PASSED"
else
    echo "⚠️  Frontend health check inconclusive — fetching logs..."
fi
ssh_cmd "docker compose -f ${SERVER_DEPLOY}/docker-compose.yml ps"

echo ""
echo "======================================================"
echo " ✅ Deploy complete."
echo "======================================================"
