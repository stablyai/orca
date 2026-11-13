#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DEVECO_STUDIO_HOME="${DEVECO_STUDIO_HOME:-/Applications/DevEco-Studio.app/Contents}"
SDK_ROOT="${DEVECO_SDK_HOME:-$DEVECO_STUDIO_HOME/sdk}"
JAVA_BIN="${JAVA_HOME:-$DEVECO_STUDIO_HOME/jbr/Contents/Home}/bin/java"
SIGN_TOOL="$SDK_ROOT/default/openharmony/toolchains/lib/hap-sign-tool.jar"
artifact="${1:-dist/orca-harmonyos-debug-signed.hap}"
if [ ! -f "$artifact" ] || [ ! -f "$SIGN_TOOL" ]; then
  echo 'Signed HAP or SDK signature tool is missing.' >&2
  exit 1
fi
mkdir -p dist/private-signature
"$JAVA_BIN" -jar "$SIGN_TOOL" verify-app -inFile "$artifact" \
  -outCertChain dist/private-signature/chain.cer \
  -outProfile dist/private-signature/profile.p7b > dist/private-signature/verification.log 2>&1
echo 'HAP signature verified. Local profile and verification log: dist/private-signature/'
