const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

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
  // Why: daemon-entry.js is forked as a separate Node.js process and must be
  // accessible on disk (not inside the asar archive) for child_process.fork().
  // Why: the CLI is compiled by tsc (not bundled), so its runtime imports
  // resolve at runtime via Node's normal module lookup. The shim launches
  // the CLI with ELECTRON_RUN_AS_NODE, which bypasses Electron's asar
  // integration — dependencies inside the asar archive are invisible to
  // require(). Unpack CLI runtime deps so they resolve from
  // app.asar.unpacked/node_modules/.
  asarUnpack: [
    'out/cli/**',
    'out/shared/**',
    'out/main/daemon-entry.js',
    'out/main/chunks/**',
    'resources/**',
    'node_modules/zod/**'
  ],
  afterPack: async (context) => {
    const resourcesDir =
      context.electronPlatformName === 'darwin'
        ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : join(context.appOutDir, 'resources')
    if (!existsSync(resourcesDir)) {
      return
    }
    for (const filename of readdirSync(resourcesDir)) {
      if (!filename.startsWith('agent-browser-')) {
        continue
      }
      // Why: the upstream package has inconsistent executable bits across
      // platform binaries (notably darwin-x64). child_process.execFile needs
      // the copied binary to be executable in packaged apps.
      chmodSync(join(resourcesDir, filename), 0o755)
    }
  },
  win: {
    executableName: 'Orca',
    extraResources: [
      {
        from: 'resources/win32/bin/orca.cmd',
        to: 'bin/orca.cmd'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
        to: 'agent-browser-win32-x64.exe'
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
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-darwin-${arch}',
        to: 'agent-browser-darwin-${arch}'
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
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-linux-${arch}',
        to: 'agent-browser-linux-${arch}'
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
