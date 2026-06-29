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

MAGICK_BIN=$(command -v magick || true)
if [ -z "$MAGICK_BIN" ]; then
  echo "Error: ImageMagick is required to trim the small macOS icon slots." >&2
  echo "Install with: brew install imagemagick" >&2
  exit 1
fi

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

# macOS list views use the small .icns slots directly. Icon Composer keeps the
# safe-area inset there, so trim only those slots while preserving larger icons.
ICONSET_DIR="$TMP_DIR/icon.iconset"
iconutil -c iconset "$BUILD_DIR/icon.icns" -o "$ICONSET_DIR"
for icon_file in \
  icon_16x16.png \
  icon_16x16@2x.png \
  icon_32x32.png \
  icon_32x32@2x.png; do
  case "$icon_file" in
    icon_16x16.png) icon_size=16 ;;
    icon_16x16@2x.png | icon_32x32.png) icon_size=32 ;;
    icon_32x32@2x.png) icon_size=64 ;;
  esac
  "$MAGICK_BIN" "$ICONSET_DIR/$icon_file" \
    -trim +repage \
    -resize "${icon_size}x${icon_size}" \
    -background none \
    -gravity center \
    -extent "${icon_size}x${icon_size}" \
    "$ICONSET_DIR/$icon_file"
done
iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
echo "  -> resources/build/icon.icns"

# Extract PNG fallbacks from the unmodified compiled icon; small-slot trimming is
# only for the macOS .icns list representations.
sips -s format png --resampleWidth 1024 "$TMP_DIR/icon.icns" --out "$BUILD_DIR/icon.png" >/dev/null 2>&1
echo "  -> resources/build/icon.png (1024x1024)"

sips -s format png --resampleWidth 256 "$TMP_DIR/icon.icns" --out "$RESOURCES_DIR/icon.png" >/dev/null 2>&1
echo "  -> resources/icon.png (256x256)"

# Generate .ico for Windows. Icon Composer keeps the macOS safe-area inset in
# the 1024px render, but Windows scales the largest ICO frame down for the
# taskbar/"Open with" list without compensating, so the glyph looks small next
# to native apps (issue #5357). Delegate to the pngjs trim script so the
# committed ICO always matches it: it trims the transparent inset, re-squares
# with a small 2% margin, and emits the filled multi-size ICO. Node + pngjs are
# already repo dependencies, so this also works where ImageMagick is unavailable.
node "$PROJECT_DIR/config/scripts/trim-windows-icon-source.mjs"
echo "  -> resources/build/icon.ico (trimmed, filled multi-size ICO)"

echo "Done! Icons generated in resources/build/ and resources/"
