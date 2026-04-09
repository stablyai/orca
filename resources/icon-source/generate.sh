#!/bin/bash
# Generate app icons from Icon Composer .icon project
# Produces: resources/build/icon.icns (macOS), resources/build/icon.png (fallback), resources/icon.png (tray)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
ICON_SOURCE="$SCRIPT_DIR/icon.icon"
BUILD_DIR="$PROJECT_DIR/resources/build"
RESOURCES_DIR="$PROJECT_DIR/resources"
TMP_DIR=$(mktemp -d)

trap 'rm -rf "$TMP_DIR"' EXIT

echo "Compiling icon from $ICON_SOURCE..."

# Generate .icns using actool (requires Xcode)
xcrun actool \
  --compile "$TMP_DIR" \
  --platform macosx \
  --minimum-deployment-target 10.12 \
  --app-icon icon \
  --output-partial-info-plist "$TMP_DIR/partial.plist" \
  "$ICON_SOURCE" >/dev/null

if [ ! -f "$TMP_DIR/icon.icns" ]; then
  echo "Error: actool failed to produce icon.icns" >&2
  exit 1
fi

cp "$TMP_DIR/icon.icns" "$BUILD_DIR/icon.icns"
echo "  -> resources/build/icon.icns"

# Extract 1024x1024 PNG from icns for electron-builder fallback & resources
sips -s format png --resampleWidth 1024 "$BUILD_DIR/icon.icns" --out "$BUILD_DIR/icon.png" >/dev/null 2>&1
echo "  -> resources/build/icon.png (1024x1024)"

sips -s format png --resampleWidth 256 "$BUILD_DIR/icon.icns" --out "$RESOURCES_DIR/icon.png" >/dev/null 2>&1
echo "  -> resources/icon.png (256x256)"

# Generate .ico for Windows (proper ICO format with multiple sizes)
if command -v magick &>/dev/null; then
  magick "$BUILD_DIR/icon.png" -define icon:auto-resize=256,128,64,48,32,16 "$BUILD_DIR/icon.ico"
  echo "  -> resources/build/icon.ico (multi-size ICO via ImageMagick)"
else
  echo "Warning: ImageMagick not found, skipping icon.ico generation" >&2
  echo "Install with: brew install imagemagick" >&2
fi

echo "Done! Icons generated in resources/build/ and resources/"
