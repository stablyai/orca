#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  process.exit(0)
}
const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output =
  outputIndex === -1
    ? resolve(root, 'native/workspace-cow-macos/.build/release/orca-workspace-cow')
    : resolve(args[outputIndex + 1])
mkdirSync(dirname(output), { recursive: true })
const architectures = args.includes('--single-arch')
  ? [process.arch === 'arm64' ? 'arm64' : 'x86_64']
  : ['arm64', 'x86_64']
execFileSync(
  'xcrun',
  [
    'clang',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=11.0',
    ...architectures.flatMap((arch) => ['-arch', arch]),
    resolve(root, 'native/workspace-cow-macos/main.c'),
    '-o',
    output
  ],
  { stdio: 'inherit' }
)
