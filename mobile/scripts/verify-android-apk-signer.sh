#!/usr/bin/env bash
# Fails unless every signer of the APK ($1) is the pinned certificate ($2, colon-separated SHA-256).
# GitHub installs only take updates signed by the same key, so a swapped or debug key must not ship.
set -euo pipefail

apk="$1"
expected="${2//:/}"
expected="${expected,,}"

apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
# Older apksigner prints "Signer #1 certificate …", newer "V3.0 Signer: certificate …"; skip source stamps.
certs="$("$apksigner" verify --print-certs "$apk" \
  | sed -En 's/^(Signer #[0-9]+|V[0-9.]+ Signer):? certificate SHA-256 digest: //p' | sort -u)"

if [ "$certs" != "$expected" ]; then
  echo "::error::$apk signing certificate ($certs) is not the Orca release key ($2)."
  exit 1
fi
echo "$apk is signed with the Orca release key $2"
