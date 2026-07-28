# Changelog

## 2026-07-28

### Revisioned mobile IME input and acknowledged delivery

- Prepared a draft replacement for #10162 without the timer-window and corrective-DEL design:
  - `mobile/packages/expo-terminal-live-input/` publishes monotonic editor revisions and native iOS marked-text / Android composing-span ranges.
  - `mobile/src/terminal/terminal-editor-transaction-reconciler.ts` holds unstable composition, ignores stale revisions, preserves grapheme boundaries, and flushes causally before Enter or external input.
  - `mobile/src/terminal/terminal-input-queue.ts` serializes deliberate terminal input, retries ambiguous delivery with the same queue sequence, and advances only on an exact host acknowledgement.
  - `src/main/runtime/terminal-input-queue-idempotency.ts` authenticates queue ownership, deduplicates concurrent and settled retries, bounds retained fingerprints, and resumes a logical mobile queue after host-process state loss.
  - The session route shares the sender across live editor, accessory, command, dictation, and gesture paths. Automated terminal query replies remain isolated.
- Added `terminal.input-queue.v1`; older hosts and builds continue using the legacy input path.
- Rebased the work on `origin/main` at `77d4c64f7a05e7fb2caa48e3d0acad5db39ff1f2`.

#### Verification

- `cd mobile && pnpm test`: 354 files passed; 2,581 tests passed and 2 skipped.
- `cd mobile && pnpm typecheck && pnpm --dir packages/expo-terminal-live-input typecheck`: passed.
- `pnpm typecheck`: all node, CLI, and web TypeScript configurations passed.
- `pnpm lint`, `cd mobile && pnpm lint`, `pnpm check:code-quality:changed`, and `pnpm check:max-lines-ratchet`: passed with zero new changed-code findings and no new max-lines bypass.
- `node_modules/.bin/vitest run --config config/vitest.config.ts src/main/runtime/terminal-input-queue-idempotency.test.ts src/main/runtime/rpc/terminal-input-queue-rpc.test.ts`: 10 tests passed.
- `cd mobile/android && ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ./gradlew :orca-expo-terminal-live-input:compileDebugKotlin`: passed.
- `cd mobile/ios && xcodebuild -project Pods/Pods.xcodeproj -target ExpoTerminalLiveInput -configuration Debug -sdk iphonesimulator ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build -quiet`: passed in Swift 5.9 mode. Xcode reports two future Swift 6 actor-isolation warnings for the view focus/blur async functions.
- No Docker commands were run.

#### Draft acceptance gates

- Keep the replacement PR in Draft until physical iOS and Android tests cover Japanese IME conversion, Korean composition, Enter confirmation, deletion, high-latency reconnect, and hardware-keyboard composition with #10447.
- Full application schemes, release packaging, and physical-device behavior are unverified. Local root checks ran on Node 26.5.0 although the repository declares Node 24.
