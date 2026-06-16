const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const electronBuilderNativeRebuild = require('./scripts/electron-builder-native-rebuild.cjs')
const {
  createPackagedRuntimeNodeModuleResources,
  prunePackagedRuntimeNodeModules,
  verifyPackagedMainRuntimeDeps
} = require('./packaged-runtime-node-modules.cjs')

const isMacRelease = process.env.ORCA_MAC_RELEASE === '1'
const featureWallResources = {
  from: 'resources/onboarding/feature-wall',
  to: 'onboarding/feature-wall'
}
// Why: SSH relay deploy resolves bundles from process.resourcesPath in packaged
// apps. Keeping relay assets as extraResources makes them real directories
// instead of paths hidden inside app.asar.
const relayExtraResource = {
  from: 'out/relay',
  to: 'relay'
}
// Why: the main bundle, packaged CLI, SSH paths, and speech worker all execute
// from package directories where pnpm's symlink farm is absent. Copy the exact
// runtime dependency closure to Resources/node_modules so bare require() calls
// do not fall through to a developer checkout's node_modules.
const packagedRuntimeNodeModuleResources = createPackagedRuntimeNodeModuleResources()

const commonExtraResources = [relayExtraResource, ...packagedRuntimeNodeModuleResources]
const macSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-darwin-${arch}',
  to: 'node_modules/sherpa-onnx-darwin-${arch}'
}
const linuxSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-linux-${arch}',
  to: 'node_modules/sherpa-onnx-linux-${arch}'
}
const winSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-win-x64',
  to: 'node_modules/sherpa-onnx-win-x64'
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.stablyai.orca',
  productName: 'Orca',
  directories: {
    buildResources: 'resources/build'
  },
  files: [
    '!**/.vscode/*',
    // Why: these repo-only inputs are either bundled into out/ or copied via
    // extraResources. Shipping them in app.asar bloats the desktop bundle.
    '!src{,/**/*}',
    '!config{,/**/*}',
    '!docs{,/**/*}',
    '!mobile{,/**/*}',
    '!native{,/**/*}',
    '!skills{,/**/*}',
    '!tests{,/**/*}',
    '!Casks{,/**/*}',
    '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md}',
    '!out/**/*.test.js',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!tsconfig.json',
    // Why: feature-wall media is copied via extraResources so runtime can read
    // it from process.resourcesPath; exclude the source copy from app.asar.
    '!resources/onboarding/feature-wall/**'
  ],
  // Why: the CLI entry-point lives in out/cli/ but imports shared modules
  // from out/shared/ and local hook mutators from out/main/. These paths must be
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
  // Why: remote runtime connections use WebSocket + E2EE from the packaged CLI
  // before the GUI process starts, so those deps need the same treatment.
  // Why: sherpa-onnx native bindings (platform-specific subpackages) must be
  // unpacked because they ship .node addons + .dylib/.so files that cannot be
  // dlopen()'d from inside the asar archive.
  asarUnpack: [
    'out/cli/**',
    'out/shared/**',
    'out/main/agent-hooks/**',
    'out/main/antigravity/**',
    'out/main/claude/**',
    'out/main/codex/**',
    'out/main/copilot/**',
    'out/main/cursor/**',
    'out/main/droid/**',
    'out/main/gemini/**',
    'out/main/grok/**',
    'out/main/hermes/**',
    'out/main/win32-utils.js',
    'out/main/daemon-entry.js',
    'out/main/computer-sidecar.js',
    'out/main/chunks/**',
    'resources/**',
    'node_modules/ws/**',
    'node_modules/tweetnacl/**',
    'node_modules/zod/**',
    'node_modules/yaml/**',
    'node_modules/sherpa-onnx*/**'
  ],
  afterPack: async (context) => {
    const resourcesDir =
      context.electronPlatformName === 'darwin'
        ? join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            'Contents',
            'Resources'
          )
        : join(context.appOutDir, 'resources')
    if (!existsSync(resourcesDir)) {
      return
    }
    prunePackagedRuntimeNodeModules(resourcesDir, context.electronPlatformName)
    verifyPackagedMainRuntimeDeps(resourcesDir)
    chmodUnixCliLaunchers(resourcesDir, context.electronPlatformName)
    chmodMacServeSimHelpers(resourcesDir, context.electronPlatformName)
    for (const filename of readdirSync(resourcesDir)) {
      if (!filename.startsWith('agent-browser-')) {
        continue
      }
      // Why: the upstream package has inconsistent executable bits across
      // platform binaries (notably darwin-x64). child_process.execFile needs
      // the copied binary to be executable in packaged apps.
      chmodSync(join(resourcesDir, filename), 0o755)
    }
    if (context.electronPlatformName === 'darwin') {
      await signMacComputerUseHelper(join(resourcesDir, 'Orca Computer Use.app'), context.packager)
    }
  },
  win: {
    executableName: 'Orca',
    extraResources: [
      ...commonExtraResources,
      winSpeechNativeResource,
      {
        from: 'resources/win32/bin/orca.cmd',
        to: 'bin/orca.cmd'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
        to: 'agent-browser-win32-x64.exe'
      },
      {
        from: 'native/computer-use-windows/runtime.ps1',
        to: 'computer-use-windows/runtime.ps1'
      },
      featureWallResources
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
      NSAppleEventsUsageDescription:
        'Orca allows terminal-launched developer tools to automate local apps when you request it.',
      NSBluetoothAlwaysUsageDescription:
        'Orca allows terminal-launched developer tools to access Bluetooth devices when you request it.',
      NSBluetoothPeripheralUsageDescription:
        'Orca allows terminal-launched developer tools to access Bluetooth devices when you request it.',
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSLocationUsageDescription:
        'Orca allows terminal-launched developer tools to access location when you request it.',
      NSLocalNetworkUsageDescription:
        'Orca allows terminal-launched developer tools to discover and connect to local development servers when you request it.',
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSAudioCaptureUsageDescription:
        'Orca allows terminal-launched developer tools to capture desktop audio when you request it.',
      NSBonjourServices: ['_http._tcp', '_https._tcp'],
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
      ...commonExtraResources,
      macSpeechNativeResource,
      {
        from: 'resources/darwin/bin/orca',
        to: 'bin/orca'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-darwin-${arch}',
        to: 'agent-browser-darwin-${arch}'
      },
      // Why: serve-sim resolves its helper binary and camera assets relative
      // to dist/serve-sim.js, so the whole package must be a real resource dir.
      {
        from: 'node_modules/serve-sim',
        to: 'serve-sim'
      },
      {
        from: 'native/computer-use-macos/.build/release/Orca Computer Use.app',
        to: 'Orca Computer Use.app'
      },
      featureWallResources
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
    // Why: Ubuntu desktop ships GNOME Orca as the `orca` package and /usr/bin/orca.
    // The Linux installer should not claim those system package/file names.
    executableName: 'orca-ide',
    // Why: the icns source lets electron-builder emit standard hicolor PNG
    // sizes; a single 1024px PNG is ignored by some Linux docks/launchers.
    icon: 'resources/build/icon.icns',
    desktop: {
      entry: {
        // Why: Electron reports WM_CLASS=orca for the visible Linux window;
        // GNOME docks need an exact match to group it with orca-ide.desktop.
        StartupWMClass: 'orca'
      }
    },
    extraResources: [
      ...commonExtraResources,
      linuxSpeechNativeResource,
      {
        from: 'resources/linux/bin/orca-ide',
        to: 'bin/orca-ide'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-linux-${arch}',
        to: 'agent-browser-linux-${arch}'
      },
      {
        from: 'native/computer-use-linux/runtime.py',
        to: 'computer-use-linux/runtime.py'
      },
      featureWallResources
    ],
    target: ['AppImage', 'deb', 'rpm'],
    maintainer: 'stablyai',
    category: 'Utility'
  },
  appImage: {
    artifactName: 'orca-linux.${ext}'
  },
  deb: {
    packageName: 'orca-ide',
    artifactName: 'orca-ide_${version}_${arch}.${ext}',
    depends: ['python3', 'python3-gi', 'gir1.2-atspi-2.0', 'at-spi2-core', 'xdotool', 'xclip']
  },
  rpm: {
    packageName: 'orca-ide',
    artifactName: 'orca-ide-${version}.${arch}.${ext}',
    depends: ['python3', 'python3-gobject', 'at-spi2-core', 'xdotool', 'xclip']
  },
  beforeBuild: electronBuilderNativeRebuild,
  // Why: must be true so that electron-builder rebuilds native modules
  // (node-pty) for each target architecture when producing dual-arch macOS
  // builds (x64 + arm64). With npmRebuild disabled, CI on an arm64 runner
  // packages arm64 binaries into the x64 DMG, causing "posix_spawnp failed"
  // on Intel Macs. The beforeBuild hook performs Orca's targeted rebuild and
  // returns false so electron-builder does not rebuild optional cpu-features.
  npmRebuild: true,
  publish: {
    provider: 'github',
    owner: 'stablyai',
    repo: 'orca',
    releaseType: 'release'
  }
}

function chmodUnixCliLaunchers(resourcesDir, electronPlatformName) {
  if (electronPlatformName === 'win32') {
    return
  }
  for (const launcherName of ['orca', 'orca-ide']) {
    const launcherPath = join(resourcesDir, 'bin', launcherName)
    if (!existsSync(launcherPath)) {
      continue
    }
    // Why: packaged Unix installs expose these extraResources as public shell
    // commands, and source/packager mode drift must not ship a non-executable CLI.
    chmodSync(launcherPath, 0o755)
  }
}

function chmodMacServeSimHelpers(resourcesDir, electronPlatformName) {
  if (electronPlatformName !== 'darwin') {
    return
  }
  const helperPaths = [
    join(resourcesDir, 'serve-sim', 'bin', 'serve-sim-bin'),
    join(resourcesDir, 'serve-sim', 'dist', 'simcam', 'serve-sim-camera-helper'),
    join(resourcesDir, 'node_modules', 'serve-sim', 'bin', 'serve-sim-bin'),
    join(resourcesDir, 'node_modules', 'serve-sim', 'dist', 'simcam', 'serve-sim-camera-helper')
  ]
  for (const helperPath of helperPaths) {
    if (existsSync(helperPath)) {
      chmodSync(helperPath, 0o755)
    }
  }
}

async function signMacComputerUseHelper(helperAppPath, packager) {
  if (!existsSync(helperAppPath)) {
    if (isMacRelease) {
      throw new Error(`Missing Orca Computer Use helper app at ${helperAppPath}`)
    }
    return
  }
  const codeSigningInfo =
    isMacRelease && process.env.CSC_LINK && packager?.codeSigningInfo?.value
      ? await packager.codeSigningInfo.value
      : null
  const identity =
    process.env.ORCA_COMPUTER_MACOS_SIGN_IDENTITY ??
    process.env.CSC_NAME ??
    findInstalledMacSigningIdentity(codeSigningInfo?.keychainFile) ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error('Missing signing identity for Orca Computer Use helper app')
  }
  // Why: TCC grants attach to this nested app's code identity. Sign it before
  // the outer Orca.app is sealed so production builds preserve that identity.
  execFileSync('codesign', codesignArgs(identity, helperAppPath), { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', helperAppPath], {
    stdio: 'inherit'
  })
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity]
  if (isMacRelease) {
    args.push(
      '--options',
      'runtime',
      '--timestamp',
      '--entitlements',
      resolve(__dirname, '../resources/build/entitlements.computer-use.mac.plist')
    )
  }
  args.push(targetPath)
  return args
}

function findInstalledMacSigningIdentity(keychainFile) {
  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', ...(keychainFile ? [keychainFile] : [])],
      {
        encoding: 'utf8'
      }
    )
    const releaseMatch =
      output.match(/"([^"]*Developer ID Application:[^"]+)"/) ??
      output.match(/"([^"]*Apple Distribution:[^"]+)"/)
    if (releaseMatch?.[1]) {
      return releaseMatch[1]
    }
    if (!isMacRelease) {
      return output.match(/"([^"]*Apple Development:[^"]+)"/)?.[1] ?? null
    }
  } catch {}
  return null
}
