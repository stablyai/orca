require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# IrohLib 1.1.0 is SPM-first; CocoaPods podspecs upstream lag at 0.35.
# Vendoring the release xcframework + UniFFI Swift bindings avoids RN's
# spm_dependency path, which redefines module `Iroh` and crashes SwiftDriver
# when mixed with CocoaPods (static or dynamic).
Pod::Spec.new do |s|
  s.name           = 'ExpoIroh'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/stablyai/orca.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'SystemConfiguration'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'OTHER_LDFLAGS' => '$(inherited) -framework Network -framework SystemConfiguration'
  }

  # Why: downloads are pinned by SHA-256 — a mutated release asset must fail
  # the pod install instead of silently linking into the app.
  s.prepare_command = <<-CMD
    set -euo pipefail
    VENDOR_DIR="Vendor"
    XCFRAMEWORK_SHA256="ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776"
    BINDINGS_SHA256="681abdbd903ad86848571dbfbbf5540733da541584edae6592e0cabef3c3b856"
    verify_sha256() {
      echo "$2  $1" | shasum -a 256 -c - >/dev/null || {
        echo "[ExpoIroh] checksum mismatch for $1" >&2
        rm -f "$1"
        exit 1
      }
    }
    mkdir -p "$VENDOR_DIR"
    if [ ! -d "$VENDOR_DIR/Iroh.xcframework" ]; then
      echo "[ExpoIroh] downloading IrohLib 1.1.0 xcframework…"
      curl -fsSL -o "$VENDOR_DIR/IrohLib.xcframework.zip" \
        "https://github.com/n0-computer/iroh-ffi/releases/download/v1.1.0/IrohLib.xcframework.zip"
      verify_sha256 "$VENDOR_DIR/IrohLib.xcframework.zip" "$XCFRAMEWORK_SHA256"
      unzip -qo "$VENDOR_DIR/IrohLib.xcframework.zip" -d "$VENDOR_DIR"
      if [ ! -d "$VENDOR_DIR/Iroh.xcframework" ] && [ -d "$VENDOR_DIR/Iroh/Iroh.xcframework" ]; then
        mv "$VENDOR_DIR/Iroh/Iroh.xcframework" "$VENDOR_DIR/"
      fi
      rm -f "$VENDOR_DIR/IrohLib.xcframework.zip"
      rm -rf "$VENDOR_DIR/Iroh"
    fi
    if [ ! -f "$VENDOR_DIR/IrohLib.swift" ]; then
      echo "[ExpoIroh] downloading IrohLib.swift bindings…"
      curl -fsSL -o "$VENDOR_DIR/IrohLib.swift" \
        "https://raw.githubusercontent.com/n0-computer/iroh-ffi/v1.1.0/IrohLib/Sources/IrohLib/IrohLib.swift"
      verify_sha256 "$VENDOR_DIR/IrohLib.swift" "$BINDINGS_SHA256"
    fi
  CMD

  s.vendored_frameworks = 'Vendor/Iroh.xcframework'
  s.source_files = [
    'ExpoIrohModule.swift',
    'IrohClient.swift',
    'IrohPathUtils.swift',
    'Vendor/IrohLib.swift'
  ]
  s.exclude_files = 'Vendor/**/*.zip'
  s.preserve_paths = 'Vendor/**/*', 'scripts/**/*'
end
