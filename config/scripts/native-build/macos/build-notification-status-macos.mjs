#!/usr/bin/env node
// Embed target CFBundleIdentifier in __TEXT,__info_plist so later release/ad-hoc codesign preserves the identifier macOS uses for notification records (native/notification-status-macos/main.swift).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
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
  build(plistPath, outputPath)
  // The release build also makes the app profile variant, with no embedded Info.plist. A profile
  // app copies it into its own Contents/MacOS and signs it with its own bundle id
  // A dev bundle (--output) needs no variant.
  if (outputPath === defaultOutputPath) {
    build(null, path.join(path.dirname(outputPath), 'profile-template', 'orca-notification-status'))
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function build(plist, output) {
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const embed = plist
    ? [
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        plist
      ]
    : []
  const builtBinaries = triples.map((triple) => {
    const binary = path.join(
      workDir,
      `orca-notification-status-${plist ? '' : 'profile-'}${triple}`
    )
    execFileSync(
      'swiftc',
      [
        '-O',
        sourcePath,
        '-target',
        triple.replace('-apple-macosx', '-apple-macosx11.0'),
        '-o',
        binary,
        ...embed
      ],
      { stdio: 'inherit' }
    )
    return binary
  })
  mkdirSync(path.dirname(output), { recursive: true })
  if (builtBinaries.length === 1) {
    execFileSync('cp', [builtBinaries[0], output])
  } else {
    execFileSync('lipo', ['-create', ...builtBinaries, '-output', output])
  }
  execFileSync('chmod', ['755', output])
}

function readArg(name) {
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
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
