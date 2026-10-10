# @orca/expo-iroh

Local Expo module: Iroh QUIC pipe for Orca mobile ↔ desktop.

See [USAGE.md](./USAGE.md).

| Item | Value |
| --- | --- |
| ALPN | `orca-mobile-rpc/1` |
| IrohLib | **1.1.0** (`n0-computer/iroh-ffi`) vendored via podspec `prepare_command` |
| iOS | full implementation (min iOS 17.5) |
| Android | compile stub (`iroh_android_not_implemented`) |

## Why not SPM in the podspec?

RN’s `spm_dependency` attaches IrohLib to the CocoaPods target, but the binary
`Iroh` module is then redefined (`redefinition of module 'Iroh'`) and SwiftDriver
fails. The podspec instead downloads the release `Iroh.xcframework` + UniFFI
`IrohLib.swift` into `ios/Vendor/` (gitignored) and compiles the bindings into
the ExpoIroh target. Both downloads are pinned to iroh-ffi v1.1.0 by SHA-256.
