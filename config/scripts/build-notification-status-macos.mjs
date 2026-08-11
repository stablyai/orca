#!/usr/bin/env node
// Builds the orca-notification-status helper binary.
//
// The helper reads UNUserNotificationCenter settings for the app it ships
// inside (see native/notification-status-macos/main.swift). The target
// CFBundleIdentifier is embedded as a __TEXT,__info_plist section so every
// later `codesign --force` pass (electron-builder's signing, the dev runner's
// ad-hoc deep sign) derives the correct code identifier automatically —
// macOS keys notification records to that identifier.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(repoRoot, 'native', 'notification-status-macos', 'main.swift')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'notification-status-macos',
  '.build',
  'release',
  'orca-notification-status'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const bundleId = readArg('--bundle-id') ?? 'com.stablyai.orca'
const outputPath = readArg('--output') ?? defaultOutputPath
// Why: dev launches only need the host architecture; release builds ship a
// universal binary matching the app's x64 + arm64 targets.
const singleArch = args.includes('--single-arch')

const workDir = path.join(tmpdir(), `orca-notification-status-${process.pid}`)
mkdirSync(workDir, { recursive: true })
try {
  const plistPath = path.join(workDir, 'Info.plist')
  writeFileSync(plistPath, embeddedInfoPlist(bundleId), 'utf8')
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const builtBinaries = triples.map((triple) => {
    const output = path.join(workDir, `orca-notification-status-${triple}`)
    execFileSync(
      'swiftc',
      [
        '-O',
        sourcePath,
        '-target',
        triple.replace('-apple-macosx', '-apple-macosx11.0'),
        '-o',
        output,
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        plistPath
      ],
      { stdio: 'inherit' }
    )
    return output
  })
  mkdirSync(path.dirname(outputPath), { recursive: true })
  if (builtBinaries.length === 1) {
    execFileSync('cp', [builtBinaries[0], outputPath])
  } else {
    execFileSync('lipo', ['-create', ...builtBinaries, '-output', outputPath])
  }
  execFileSync('chmod', ['755', outputPath])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function embeddedInfoPlist(identifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleName</key>
  <string>orca-notification-status</string>
</dict>
</plist>
`
}
