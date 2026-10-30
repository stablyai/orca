# Temporary macOS 12 support notice

The desktop checks upgrade support before recommending a path. Apple Silicon (including Rosetta) supports macOS 13. Intel Macs are checked against Apple's Ventura model boundaries using a cached, one-second `sysctl hw.model` probe. An unavailable or unrecognized model stays undecided; the dialog then offers Apple's guide.

## Remove after the transition

Delete these feature folders:

- `src/main/macos-12-support-notice/`: local probe, Intel compatibility data, and tests.
- `src/shared/macos-12-support-notice/`: IPC result type and local-client audience rule.
- `src/renderer/src/components/feature-tips/macos-12-support-notice/`: dialog, probe lifecycle, and fixtures.

Remove the `getMacosUpgradeSupport` IPC/preload/web API wiring, the `macos-12-support` feature tip and its startup/modal gates, and the `macosSupport` localization namespace. Keep persisted unknown tip IDs safely ignored by the existing normalizer.

## Sources for compatibility and explanation copy

- [Apple's macOS Ventura models](https://support.apple.com/en-us/102861).
- [Electron 44](https://www.electronjs.org/blog/electron-44-0): Chromium drops macOS 12; Electron 44+ requires macOS 13.
- [Electron 45](https://www.electronjs.org/blog/electron-45-0): macOS cold-launch improvements, reduced native API and IPC overhead, and async secure-storage migration.
- [Electron's breaking changes](https://www.electronjs.org/docs/latest/breaking-changes): the macOS notification migration to UNNotification began in Electron 42. The dialog describes ongoing integration with current notification and Keychain APIs, without claiming those APIs first arrived in 45.
