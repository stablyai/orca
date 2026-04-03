const isMacRelease = process.env.ORCA_MAC_RELEASE === '1'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.stablyai.orca',
  productName: 'Orca',
  directories: {
    buildResources: 'build'
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  asarUnpack: ['out/cli/**', 'resources/**'],
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
    icon: 'build/icon.icns',
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
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
  npmRebuild: false,
  publish: {
    provider: 'github',
    owner: 'stablyai',
    repo: 'orca',
    releaseType: 'release'
  }
}
