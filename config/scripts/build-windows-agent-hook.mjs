#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileWindowsRustExecutable } from './windows-rust-executable-build.mjs'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = resolve(import.meta.dirname, '../..')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  const crateRoot = join(repoRoot, 'native', 'windows-agent-hook')
  compileWindowsRustExecutable({
    repoRoot,
    crateRoot,
    binName: 'orca-agent-hook',
    label: 'Windows agent hook',
    fingerprintInputs: [iconPath, join(repoRoot, 'config/scripts/build-windows-agent-hook.mjs')],
    arch: readArg('--arch') ?? process.arch,
    outputPath: readArg('--output') ?? join(crateRoot, '.build', 'orca-agent-hook.exe'),
    buildEnv: (version) => ({
      ORCA_HOOK_BUILD_VERSION: version,
      ORCA_HOOK_BUILD_ICON: iconPath
    })
  })
}
