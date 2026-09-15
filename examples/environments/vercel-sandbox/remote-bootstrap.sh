#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# The managed Node 24 image is Ubuntu; these package names target 24.04 and newer.
sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential ca-certificates curl file git \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
  libdrm2 libgbm1 libgtk-3-0t64 libnss3 libpango-1.0-0 libsecret-1-dev libx11-xcb1 \
  libxcb-dri3-0 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 \
  libxss1 libxtst6 pkg-config python3 rpm xvfb zlib1g-dev
sudo corepack enable
corepack prepare pnpm@12.0.0 --activate
sudo npm install -g @openai/codex@0.154.0
[ ! -e /vercel/orca-profile ] && [ ! -e /vercel/project ]
[ ! -e "$HOME/.config/orca-dev" ] || { echo 'Seed contains Orca identity; use a clean base' >&2; exit 1; }
if [ ! -d /vercel/orca-runtime/.git ]; then
  git init -b main /vercel/orca-runtime
  git -C /vercel/orca-runtime remote add origin https://github.com/stablyai/orca.git
fi
cd /vercel/orca-runtime
git fetch --depth 1 origin "$ORCA_REF"
git checkout --detach FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$ORCA_REF" ]
pnpm install --frozen-lockfile
pnpm run build:cli
ORCA_ELECTRON_VITE_TARGET=main node config/scripts/run-electron-vite-build.mjs --config config/electron-vite-target.config.cts
[ -s out/cli/index.js ] && [ -s out/main/index.js ]
mkdir -p /vercel/orca-control
printf '%s' "$ORCA_REF" >/vercel/orca-control/runtime-ref
