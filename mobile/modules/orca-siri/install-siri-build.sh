#!/bin/bash
# Installs the Siri build of Orca mobile (ORCA_SIRI=1) on a USB-connected iPhone. macOS + Xcode only.
#   install-siri-build.sh            reinstall the last Release build
#   install-siri-build.sh --build    rebuild from this checkout first (add --clean for a fresh prebuild)
# Env: ORCA_IOS_BUNDLE_ID (default com.<user>.orca.mobile, so it sits next to the App Store Orca),
#      ORCA_IOS_DEVICE (UDID; default: the first connected iPhone).
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE_ID="${ORCA_IOS_BUNDLE_ID:-com.$(whoami | tr -cd '[:alnum:]').orca.mobile}"
BUILD=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --clean) BUILD=1 CLEAN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

DEVICE="${ORCA_IOS_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  devices_json="$(mktemp)"
  xcrun devicectl list devices --json-output "$devices_json" > /dev/null
  DEVICE="$(jq -r '[.result.devices[] | select(.hardwareProperties.deviceType == "iPhone"
    and .hardwareProperties.reality == "physical"
    and .connectionProperties.tunnelState != "unavailable")][0].hardwareProperties.udid // empty' "$devices_json")"
  rm -f "$devices_json"
fi
if [ -z "$DEVICE" ]; then
  echo "No connected iPhone. Plug it in by USB, unlock it and tap Trust." >&2
  exit 1
fi
echo "iPhone $DEVICE, bundle id $BUNDLE_ID"

BUILD_MARK=""
if [ "$BUILD" = 1 ]; then
  cd "$MOBILE_DIR"
  export ORCA_SIRI=1 ORCA_WATCH_SPIKE="${ORCA_WATCH_SPIKE:-1}" ORCA_IOS_BUNDLE_ID="$BUNDLE_ID" CI=1
  [ "$CLEAN" = 1 ] && npx expo prebuild --platform ios --clean
  BUILD_MARK="$(mktemp)"
  trap 'rm -f "$BUILD_MARK"' EXIT
  # Also installs; on a locked phone only the launch fails, so the exit code alone can't tell a failed build.
  npx expo run:ios --device "$DEVICE" --configuration Release --no-bundler || true
fi

# ls -t picks the newest DerivedData build when several exist.
# shellcheck disable=SC2012
APP="$(ls -td "$HOME"/Library/Developer/Xcode/DerivedData/Orca-*/Build/Products/Release-iphoneos/Orca.app 2>/dev/null | head -1)"
if [ -z "$APP" ]; then
  echo "No Release build found. Run with --build." >&2
  exit 1
fi
if [ -n "$BUILD_MARK" ] && [ -z "$(find "$APP" -newer "$BUILD_MARK" -print -quit)" ]; then
  echo "The build failed, so the older app at $APP was not installed. See the Xcode errors above." >&2
  exit 1
fi
built_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist")"
if [ "$built_id" != "$BUNDLE_ID" ]; then
  echo "The last build is $built_id, not $BUNDLE_ID. Run with --build." >&2
  exit 1
fi
if [ ! -d "$APP/Metadata.appintents" ]; then
  echo "The last build has no Siri intents (built without ORCA_SIRI=1). Run with --clean." >&2
  exit 1
fi

echo "Installing $version from $APP"
xcrun devicectl device install app --device "$DEVICE" "$APP" > /dev/null
xcrun devicectl device info apps --device "$DEVICE" --bundle-id "$BUNDLE_ID" | grep "$BUNDLE_ID"

cat <<EOF

Installed. On the phone:
  1. Open this Orca once (if iOS blocks it: Settings > General > VPN & Device Management > Trust).
  2. Settings > Troubleshoot > Siri bridge: check the URL, then tap Test Siri connection.
  3. Say "Hey Siri, check Orca".
EOF
