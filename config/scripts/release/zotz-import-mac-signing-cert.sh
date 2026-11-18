#!/usr/bin/env bash
# CI: turns the Zotz self-signed certificate into a valid codesign identity so electron-builder
# and the afterPack helper signing find it through CSC_NAME (docs/zotz/UPDATES-SPEC.md §6).
set -euo pipefail

: "${ZOTZ_MAC_CERT_P12:?}" "${ZOTZ_MAC_CERT_PASSWORD:?}" "${ZOTZ_MAC_SIGNING_NAME:?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
keychain="${RUNNER_TEMP:-$work}/zotz-signing.keychain-db"
keychain_password="$(openssl rand -hex 16)"

printf '%s' "$ZOTZ_MAC_CERT_P12" | base64 --decode > "$work/identity.p12"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P "$ZOTZ_MAC_CERT_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# shellcheck disable=SC2046 # word-split the existing keychain list on purpose
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

# electron-builder only lists identities `security find-identity -v` calls valid, which needs trust.
security find-certificate -c "$ZOTZ_MAC_SIGNING_NAME" -p "$keychain" > "$work/cert.pem"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$work/cert.pem"

if ! security find-identity -v -p codesigning "$keychain" | grep -q "\"$ZOTZ_MAC_SIGNING_NAME\""; then
  security find-identity -p codesigning "$keychain" >&2
  echo "::error::$ZOTZ_MAC_SIGNING_NAME is not a valid codesign identity on this runner." >&2
  exit 1
fi
echo "Signing identity ready: $ZOTZ_MAC_SIGNING_NAME"
