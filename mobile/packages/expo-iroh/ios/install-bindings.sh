#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
VENDOR_DIR="Vendor"
XCFRAMEWORK_SHA256="ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776"
BINDINGS_SHA256="681abdbd903ad86848571dbfbbf5540733da541584edae6592e0cabef3c3b856"

verify_sha256() {
  echo "$2  $1" | shasum -a 256 -c - >/dev/null || {
    echo "[ExpoIroh] checksum mismatch for $1; remove it and run pod install again" >&2
    exit 1
  }
}

mkdir -p "$VENDOR_DIR"
TEMP_DIR="$(mktemp -d "$VENDOR_DIR/.iroh-XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

ARCHIVE="$VENDOR_DIR/IrohLib.xcframework.zip"
if [ ! -f "$ARCHIVE" ]; then
  echo "[ExpoIroh] downloading IrohLib 1.1.0 xcframework…"
  curl --proto '=https' --proto-redir '=https' -fsSL -o "$TEMP_DIR/IrohLib.xcframework.zip" \
    "https://github.com/n0-computer/iroh-ffi/releases/download/v1.1.0/IrohLib.xcframework.zip"
  verify_sha256 "$TEMP_DIR/IrohLib.xcframework.zip" "$XCFRAMEWORK_SHA256"
  mv "$TEMP_DIR/IrohLib.xcframework.zip" "$ARCHIVE"
else
  verify_sha256 "$ARCHIVE" "$XCFRAMEWORK_SHA256"
fi

BINDINGS="$VENDOR_DIR/IrohLib.swift"
if [ ! -f "$BINDINGS" ]; then
  echo "[ExpoIroh] downloading IrohLib.swift bindings…"
  curl --proto '=https' --proto-redir '=https' -fsSL -o "$TEMP_DIR/IrohLib.swift" \
    "https://raw.githubusercontent.com/n0-computer/iroh-ffi/v1.1.0/IrohLib/Sources/IrohLib/IrohLib.swift"
  verify_sha256 "$TEMP_DIR/IrohLib.swift" "$BINDINGS_SHA256"
  mv "$TEMP_DIR/IrohLib.swift" "$BINDINGS"
else
  verify_sha256 "$BINDINGS" "$BINDINGS_SHA256"
fi

# ponytail: cache the pinned archive, not unchecked extracted framework contents.
unzip -qo "$ARCHIVE" -d "$TEMP_DIR"
FRAMEWORK="$TEMP_DIR/Iroh.xcframework"
if [ ! -d "$FRAMEWORK" ]; then
  FRAMEWORK="$TEMP_DIR/Iroh/Iroh.xcframework"
fi
if [ ! -d "$FRAMEWORK" ]; then
  echo "[ExpoIroh] Iroh.xcframework missing from release archive" >&2
  exit 1
fi
rm -rf "$VENDOR_DIR/Iroh.xcframework"
mv "$FRAMEWORK" "$VENDOR_DIR/Iroh.xcframework"
