#!/usr/bin/env node
// Builds native/ghostty-terminal-macos into a Node-API addon (universal arm64 + x86_64).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'darwin') {
  console.log('ghostty-terminal-macos: skipped (macOS only)')
  process.exit(0)
}

const root = path.resolve(import.meta.dirname, '../..')
const moduleDir = path.join(root, 'native/ghostty-terminal-macos')
const vendorDir = path.join(moduleDir, 'vendor/libghostty')
const outDir = path.join(moduleDir, 'build')
const out = path.join(outDir, 'ghostty_terminal.node')
const nodeHeaders = path.join(path.dirname(path.dirname(process.execPath)), 'include/node')

for (const required of [
  path.join(vendorDir, 'lib/libghostty.a'),
  path.join(nodeHeaders, 'node_api.h')
]) {
  if (!existsSync(required)) {
    console.error(`ghostty-terminal-macos: missing ${required}`)
    process.exit(1)
  }
}
mkdirSync(outDir, { recursive: true })

const archs = (process.env.ORCA_GHOSTTY_ARCHS ?? 'arm64 x86_64').split(/\s+/).filter(Boolean)
execFileSync(
  'xcrun',
  [
    'clang++',
    ...archs.flatMap((arch) => ['-arch', arch]),
    '-std=c++20',
    '-ObjC++',
    '-fobjc-arc',
    '-O2',
    '-mmacosx-version-min=13.0',
    '-DNAPI_VERSION=8',
    '-DNODE_GYP_MODULE_NAME=ghostty_terminal',
    `-I${nodeHeaders}`,
    `-I${path.join(vendorDir, 'include')}`,
    path.join(moduleDir, 'src/ghostty_terminal.mm'),
    path.join(vendorDir, 'lib/libghostty.a'),
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-lc++',
    ...[
      'AppKit',
      'Carbon',
      'CoreGraphics',
      'CoreImage',
      'CoreText',
      'CoreVideo',
      'IOSurface',
      'Metal',
      'MetalKit',
      'QuartzCore',
      'UniformTypeIdentifiers'
    ].flatMap((framework) => ['-framework', framework]),
    '-o',
    out
  ],
  { stdio: 'inherit' }
)
console.log(`ghostty-terminal-macos: built ${path.relative(root, out)}`)
