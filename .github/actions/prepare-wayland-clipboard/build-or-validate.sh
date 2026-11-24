#!/usr/bin/env bash
# Validates restored helpers and rebuilds once from source when a restored copy is unusable.
set -e
build() {
  node config/scripts/native-build/linux/build-wayland-clipboard.mjs &&
    node config/scripts/native-build/posix/build-provider-exec.mjs --target "linux-$(node -p process.arch)" &&
    node config/scripts/native-build/build-journal-file-lock.mjs --desktop-linux
}
if build; then
  exit 0
fi
if [ "${CACHE_HIT:-}" != true ]; then
  exit 1
fi
echo 'Discarding unusable Linux native helper caches and rebuilding from source.'
rm -rf -- native/wayland-clipboard/.build native/provider-exec/.build native/journal-file-lock/.build
build
