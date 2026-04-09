const isMacRelease = process.env.ORCA_MAC_RELEASE === '1'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.stablyai.orca',
  productName: 'Orca',
  directories: {
    buildResources: 'resources/build'
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!tsconfig.json',
    '!config/*'
  ],
  // Why: the CLI entry-point lives in out/cli/ but imports shared modules
  // from out/shared/ (e.g. runtime-bootstrap). Both directories must be
  // unpacked so that Node's require() can resolve the cross-directory imports
  // when the CLI runs outside the asar archive.
  asarUnpack: ['out/cli/**', 'out/shared/**', 'resources/**'],
  win: {
    executableName: 'Orca',
    extraResources: [
      {
        from: 'resources/win32/bin/orca.cmd',
        to: 'bin/orca.cmd'
      }
    ]
  },
  nsis: {
    artifactName: 'orca-windows-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
    icon: 'resources/build/icon.icns',
    entitlements: 'resources/build/entitlements.mac.plist',
    entitlementsInherit: 'resources/build/entitlements.mac.plist',
    extendInfo: {
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSDocumentsFolderUsageDescription:
        "Application requests access to the user's Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Application requests access to the user's Downloads folder."
    },
    // Why: local macOS validation builds should launch without Apple release
    // credentials. Hardened runtime + notarization stay enabled only on the
    // explicit release path so production artifacts remain strict while dev
    // artifacts do not fail with broken ad-hoc launch behavior.
    hardenedRuntime: isMacRelease,
    notarize: isMacRelease,
    extraResources: [
      {
        from: 'resources/darwin/bin/orca',
        to: 'bin/orca'
      }
    ],
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ]
  },
  // Why: release builds should fail if signing is unavailable instead of
  // silently downgrading to ad-hoc artifacts that look shippable in CI logs.
  forceCodeSigning: isMacRelease,
  dmg: {
    artifactName: 'orca-macos-${arch}.${ext}'
  },
  linux: {
    extraResources: [
      {
        from: 'resources/linux/bin/orca',
        to: 'bin/orca'
      }
    ],
    target: ['AppImage', 'deb'],
    maintainer: 'stablyai',
    category: 'Utility'
  },
  appImage: {
    artifactName: 'orca-linux.${ext}'
  },
  // Why: must be true so that electron-builder rebuilds native modules
  // (node-pty) for each target architecture when producing dual-arch macOS
  // builds (x64 + arm64). With npmRebuild disabled, CI on an arm64 runner
  // packages arm64 binaries into the x64 DMG, causing "posix_spawnp failed"
  // on Intel Macs.
  npmRebuild: true,
  publish: {
    provider: 'github',
    owner: 'stablyai',
    repo: 'orca',
    releaseType: 'release'
  }
}
