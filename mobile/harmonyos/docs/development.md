# Development and signing

## Tools

Use Node 24+ for the source checks. API 26 DevEco Studio supplies the separate Node/JBR/hvigor environment for ArkTS compilation. No npm or ohpm application dependencies are downloaded: the few JS runtime dependencies are pinned under `tools/vendor/`.

The build wrapper defaults to `/Applications/DevEco-Studio.app/Contents`. Set `DEVECO_STUDIO_HOME` for another installation, or configure `HVIGOR_BIN`, `DEVECO_SDK_HOME`, `NODE_HOME` and `JAVA_HOME` explicitly. SDK shell builds have been exercised on macOS ARM64; Linux requires those paths, while Windows builds should use DevEco Studio.

```bash
node tools/configure-build.mjs
node tools/check.mjs
bash -n tools/build.sh
bash tools/build.sh --clean
```

`tools/check.mjs` checks the source export for credential patterns, verifies generated vendor output and executes public-entry regressions, SHA/HMAC/HKDF vectors and pinned upstream direct/relay E2EE interoperability vectors against actual ArkTS source. The Node loader removes types and substitutes platform APIs; it is not an ArkTS typechecker or a UI/device test. The SDK compile is a separate required gate.

## Physical-device signing

1. Open the project in DevEco Studio and connect an API 26 HarmonyOS device with developer mode and USB debugging enabled.
2. Run `node tools/configure-build.mjs` if the ignored `build-profile.json5` is missing. Set `bundleName` on the `app.products` entry named `default` to match your development provisioning profile. For an existing test install, use its bundle name and signing profile to keep the same app identity. The checked-in `AppScope/app.json5` uses an example identity for unsigned emulator builds.
3. Open Project Structure → Signing Configs, sign in to your Huawei account and configure signing for the `default` product and connected device. DevEco stores signing settings in the ignored local `build-profile.json5`.
4. Run `bash tools/build.sh --clean --require-signed`, then `bash tools/verify-hap.sh`.
5. Verify the output's signing/profile and target device before installing. Signed HAPs may contain device provisioning data and belong in local artifacts, not in a source PR.

The configure command preserves existing local signing. The example configuration has no keys, certificate paths or passwords. Never copy local credentials into the example, Git or a PR attachment. Back up local signing material outside the project if you need to reinstall DevEco Studio.

## Artifacts

- `dist/orca-harmonyos-debug-signed.hap` or `dist/orca-harmonyos-debug-unsigned.hap`
- Matching `.sha256` and `dist/build-report.json` with build mode, SDK API and source fingerprint
- `dist/orca-harmonyos-source.tar.gz` and `dist/source-manifest.json` from `node tools/package.mjs --source`

The source export uses an explicit file set. IDE state, staging copies, local signing, personal plans, logs, packages and caches are excluded. From an extracted archive, run configure, source checks and a clean unsigned SDK build to verify the fresh-checkout path.

## Pinned vendor updates

Regenerate ArkTS vendor modules with `node tools/prepare-vendor.mjs`. `tools/patch-nacl-arkts.mjs` remains an alias. A vendor update must retain licenses, update the provenance manifest and pass `tools/check.mjs`. Run a clean SDK build after changing vendored JavaScript.

The native Agents tab and Network diagnostics use the shared iOS and Android models. From a checkout with the upstream dependencies installed, run `node mobile/harmonyos/tools/sync-mobile-models.mjs` to rebuild the bundles from `origin/main`. The script records the upstream revision and input files and rejects runtime imports. Standalone exports build with the checked-in output.

The build/export commands fingerprint the explicit source set. A source change during SDK compilation or copying fails delivery instead of stamping a newer source fingerprint onto an older HAP. Keep the source stable for a final build. UI assets have separate pinned hashes and packaged licenses; the source checks validate them too.
