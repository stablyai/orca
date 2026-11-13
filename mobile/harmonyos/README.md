# Orca Mobile for HarmonyOS

Experimental ArkTS client for [Orca](https://github.com/stablyai/orca). It pairs with an Orca desktop over E2EE and renders the desktop-provided mobile web shell in ArkWeb. This is an API 26 prototype for HarmonyOS 7; HarmonyOS 5/6 and AppGallery distribution are not supported by this build.

## Build and check

Requirements: Node 24 or newer for source checks; DevEco Studio with HarmonyOS SDK API 26, bundled hvigor and JBR for HAP compilation. The shell build wrapper is supported on macOS/Linux with a configured DevEco installation. On Windows, open the project and build with DevEco Studio.

```bash
node tools/configure-build.mjs
node tools/check.mjs
bash tools/build.sh --clean
```

`build-profile.example.json5` is the unsigned, committed template. `build-profile.json5` is local and ignored. The configure command preserves existing signing settings. For a physical device, set the `default` product's `bundleName` in the local profile to match your development provisioning profile. Configure signing for that product in DevEco Studio, then run:

```bash
bash tools/build.sh --clean --require-signed
```

The artifact, checksum and build metadata are written to `dist/`. A signed HAP still needs a valid device provisioning profile; an unsigned build is for the emulator. The scripts do not install on or erase a phone.

See [development and signing](docs/development.md), the [device test guide](docs/device-testing.md), and [architecture](docs/architecture.md).

## Current scope

- Native home, multi-host catalogs, usage and automation data, QR/manual pairing and connection diagnostics.
- Pinned E2EE v2 direct and relay transport, durable resume credentials, relocation/rotation and reconnect with direct-path upgrade.
- Desktop-provided workspace/session, task, automation, account, file, review and source-control pages in fenced ArkWeb.
- Bounded multipart RPC replies, terminal and browser image streams, remote execution-host envelopes, encrypted device cache/draft rows and mirrored native preferences.
- Native text clipboard, photo/file and clipboard-image selection, image copy/save/share, PDF preview, 16 kHz microphone capture and system offline Mandarin recognition.
- Shared terminal scale/shortcut preferences, default Chat UI, browser link destination, theme, UI language and online notification filters.

See the [verification status](docs/parity.md#verification-status) for evidence, pending acceptance and release blockers, and the [capability matrix](docs/parity.md#capability-matrix) for the implementation boundaries. The official Orca push gateway accepts iOS/Android registrations only, so HarmonyOS remote push while the application is terminated is blocked by the gateway. This project does not deploy or modify that service. System offline recognition supports Mandarin; other languages can use the paired computer where configured. Native labels use the mobile locale catalogs; HarmonyOS-specific descriptions fall back to English outside Simplified Chinese.

Source checks execute actual ArkTS logic with platform adapters and fixed upstream E2EE/RFC vectors. They supplement SDK compilation. Real camera, microphone quality, OS interruption, system media dialogs, relay service and background/lifecycle behavior require the physical-device acceptance checks. A compiled implementation is not a claim of complete Android/iOS product parity.

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
