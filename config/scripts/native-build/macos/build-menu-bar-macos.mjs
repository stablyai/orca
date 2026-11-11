import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

export function menuBarBuildIdentity(repoRoot) {
  const hash = createHash('sha256')
  for (const file of [
    'native/menu-bar-macos/main.swift',
    'config/scripts/native-build/macos/build-menu-bar-macos.mjs',
    'config/scripts/native-build/macos/swift-cli-helper-macos.mjs'
  ]) {
    hash.update(readFileSync(path.join(repoRoot, file)))
  }
  return hash.digest('hex')
}

export function menuBarAppFiles(appPath) {
  return ['MacOS/orca-menu-bar', 'Info.plist'].map((file) => path.join(appPath, 'Contents', file))
}

export function buildDevMenuBarApp(parentAppPath, parentBundleId) {
  buildMenuBarApp({
    appPath: path.join(parentAppPath, 'Contents/Resources/Orca Menu Bar.app'),
    bundleId: `${parentBundleId}.menu-bar`,
    singleArch: true
  })
}

export function buildMenuBarApp({
  appPath,
  bundleId = 'com.stablyai.orca.menu-bar',
  singleArch = false
} = {}) {
  if (process.platform !== 'darwin') {
    return
  }
  const root = path.resolve(import.meta.dirname, '../../../..')
  appPath ??= path.join(root, 'native/menu-bar-macos/.build/release/Orca Menu Bar.app')
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version.split(
    /[+-]/
  )[0]
  const executable = path.join(appPath, 'Contents/MacOS/orca-menu-bar')
  buildSwiftCliHelper({
    nativeDir: 'menu-bar-macos',
    executable: 'orca-menu-bar',
    minimumMacOSVersion: '13.4',
    argv: [...(singleArch ? ['--single-arch'] : []), '--output', executable]
  })
  mkdirSync(path.join(appPath, 'Contents'), { recursive: true })
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]
    )
  writeFileSync(
    path.join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>orca-menu-bar</string>
<key>CFBundleIdentifier</key><string>${escape(bundleId)}</string>
<key>CFBundleName</key><string>Orca Menu Bar</string>
<key>CFBundleDisplayName</key><string>Orca Menu Bar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${escape(version)}</string>
<key>CFBundleShortVersionString</key><string>${escape(version)}</string>
<key>LSMinimumSystemVersion</key><string>13.4</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  buildMenuBarApp()
}
