# Orca Mobile for HarmonyOS

Experimental ArkTS client for [Orca](https://github.com/stablyai/orca). It pairs with an Orca desktop over E2EE and renders the desktop-provided mobile web shell in ArkWeb. This is an API 26 prototype for HarmonyOS 7; HarmonyOS 5/6 and AppGallery distribution are not supported by this build.

## Build and check

Requirements: Node 24 or newer for source checks; DevEco Studio with HarmonyOS SDK API 26, bundled hvigor and JBR for HAP compilation. The shell build wrapper is supported on macOS/Linux with a configured DevEco installation. On Windows, open the project and build with DevEco Studio.

```bash
node tools/configure-build.mjs
node tools/check.mjs
bash tools/build.sh --clean
```

`build-profile.example.json5` is the unsigned, committed template. `build-profile.json5` is local and ignored; the configure command never overwrites an existing signing configuration. For a physical device, use DevEco Studio's automatic signing with your own Huawei account, bundle ID and registered device, then run:

```bash
bash tools/build.sh --clean --require-signed
```

The artifact, checksum and build metadata are written to `dist/`. A signed HAP still needs a valid device provisioning profile; an unsigned build is for the emulator. The scripts do not install on or erase a phone.

See [development and signing](docs/development.md), the [device test guide](docs/device-testing.md), and [architecture](docs/architecture.md).

## Current scope

- Native host catalog, QR/manual pairing, credential storage, supervised E2EE v2 connections and connection diagnostics.
- Desktop bundle download with hash/path/size validation, fenced ArkWeb, RPC routing and host-scoped durable page storage.
- Terminal binary streams, reconnect/reopen behavior, native clipboard text, file/photo selection and PCM audio bridge.
- Theme, home/terminal text sizing, terminal shortcuts and local agent notification preferences.
- Device routes for pairing and notification targets.

The desktop supplies the core workspace/session UI. On-device transcription and proportional terminal fonts are disabled. Screencast, Huawei remote push and AppGallery release signing are not implemented. Microphone quality, real camera pairing, notification clicks, device interruptions and background network changes require the physical-device acceptance checks.

Source regressions use public entry points and fake platform interfaces; crypto vectors execute the actual `Sha256.ets` implementation. They supplement ArkTS compilation and device testing.

## Layout

```text
AppScope/                 Application identity and resources
entry/src/main/ets/       Native pages, transport, bridge, storage and device adapters
entry/src/main/resources/ Packaged resources and third-party notices
hvigor/                   SDK build configuration
tools/                    Build, source checks, export and pinned vendor sources
docs/                     Architecture, development and device verification
```

The local IDE state, signing files, `.staging/`, agent history and build caches are intentionally excluded from source exports. Generate a clean source package with `node tools/package.mjs --source`; its file manifest is `dist/source-manifest.json`.

## Contribution status

This prototype advances [HarmonyOS support #35613](https://github.com/stablyai/orca/issues/35613) and [#10869](https://github.com/stablyai/orca/issues/10869). It does not satisfy those issues' complete platform/parity/distribution criteria. The proposed upstream location is `mobile/harmonyos/`, isolated from the existing Expo application.

MIT; upstream and third-party attribution are in [LICENSE](LICENSE), [NOTICE](NOTICE), and `tools/vendor/*/LICENSE`.
