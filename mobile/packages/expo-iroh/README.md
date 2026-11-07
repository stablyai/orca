# @orca/expo-iroh

Local Expo module: Iroh QUIC pipe for Orca mobile ↔ desktop.

See [USAGE.md](./USAGE.md).

| Item    | Value                                                                               |
| ------- | ----------------------------------------------------------------------------------- |
| ALPN    | `orca-mobile-rpc/1`                                                                 |
| iOS     | IrohLib **1.1.0**, vendored via podspec; minimum iOS 17.5                           |
| Android | Official `computer.iroh:iroh-android:1.2.0` Maven AAR; minimum Android 7.0 (API 24) |

Both platforms provide the same framed QUIC byte pipe. The Android AAR includes
all four app ABIs and the Android DNS/JNA integration; no local Rust build is required.
Version 1.2.0 includes the upstream 16-KiB native-library alignment fixes.

Builds without the native module still reject Iroh-only pairing QR codes safely.
Rebuild the native app to enable Iroh, or select desktop **Local network** or **Relay**
and scan a new QR code.

## Why not SPM in the podspec?

RN’s `spm_dependency` attaches IrohLib to the CocoaPods target, but the binary
`Iroh` module is then redefined (`redefinition of module 'Iroh'`) and SwiftDriver
fails. The podspec instead downloads the release `Iroh.xcframework` + UniFFI
`IrohLib.swift` into `ios/Vendor/` (gitignored) and compiles the bindings into
the ExpoIroh target. Both downloads are pinned to iroh-ffi v1.1.0 by SHA-256.

Local CocoaPods `:path` installs run the same installer when the podspec is
evaluated (CocoaPods skips `prepare_command` for development pods). The installer
rechecks cached bindings and the retained archive, then replaces the extracted
framework from the verified archive. A checksum mismatch aborts installation.

Android pins the Maven version, not a repository-reviewed artifact checksum;
its binary provenance still relies on Maven Central and the upstream publisher.
