#!/usr/bin/env bash
# Build with the locally configured DevEco toolchain and signing profile.
set -euo pipefail
cd "$(dirname "$0")/.."

clean=false
require_signed=false
build_mode=debug
while [ "$#" -gt 0 ]; do
  case "$1" in
    --clean) clean=true ;;
    --require-signed) require_signed=true ;;
    --release) build_mode=release ;;
    --help|-h)
      echo 'Usage: bash tools/build.sh [--clean] [--require-signed] [--release]'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

DEVECO_STUDIO_HOME="${DEVECO_STUDIO_HOME:-/Applications/DevEco-Studio.app/Contents}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$DEVECO_STUDIO_HOME/sdk}"
export NODE_HOME="${NODE_HOME:-$DEVECO_STUDIO_HOME/tools/node}"
export JAVA_HOME="${JAVA_HOME:-$DEVECO_STUDIO_HOME/jbr/Contents/Home}"
export PATH="$NODE_HOME/bin:$JAVA_HOME/bin:$PATH"
HVIGOR_BIN="${HVIGOR_BIN:-$DEVECO_STUDIO_HOME/tools/hvigor/bin/hvigorw}"
if [ ! -x "$HVIGOR_BIN" ]; then
  echo 'DevEco hvigor not found. Set DEVECO_STUDIO_HOME or HVIGOR_BIN (see docs/development.md).' >&2
  exit 1
fi
node tools/configure-build.mjs
node tools/prepare-vendor.mjs --check
source_fingerprint="$(node tools/package.mjs --fingerprint)"
if "$clean"; then "$HVIGOR_BIN" clean --no-daemon; fi
"$HVIGOR_BIN" assembleHap --mode module -p product=default -p "buildMode=$build_mode" --no-daemon

if [ "$source_fingerprint" != "$(node tools/package.mjs --fingerprint)" ]; then
  echo 'Source changed during the build. Rebuild from a stable snapshot before distributing this HAP.' >&2
  exit 1
fi
output_dir=entry/build/default/outputs/default
if [ -f "$output_dir/entry-default-signed.hap" ]; then
  artifact="$output_dir/entry-default-signed.hap"
  signed=true
elif [ -f "$output_dir/entry-default-unsigned.hap" ]; then
  artifact="$output_dir/entry-default-unsigned.hap"
  signed=false
else
  echo 'Build finished without an expected HAP artifact.' >&2
  exit 1
fi
if "$require_signed" && ! "$signed"; then
  echo 'A signed HAP is required. Configure local signing in DevEco Studio and rebuild.' >&2
  exit 1
fi
node tools/package.mjs --hap "$artifact" --build-mode "$build_mode" --source-fingerprint "$source_fingerprint"
