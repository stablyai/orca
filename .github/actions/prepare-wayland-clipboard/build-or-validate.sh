#!/usr/bin/env bash
# Validates a restored helper and rebuilds once from source when the restored copy is unusable.
set -e
if node config/scripts/build-wayland-clipboard.mjs; then
  exit 0
fi
if [ "${CACHE_HIT:-}" != true ]; then
  exit 1
fi
echo 'Discarding an unusable Wayland clipboard cache and rebuilding from source.'
rm -rf -- native/wayland-clipboard/.build
node config/scripts/build-wayland-clipboard.mjs
