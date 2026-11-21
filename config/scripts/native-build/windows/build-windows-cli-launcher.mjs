#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileWindowsRustExecutable } from './windows-rust-executable-build.mjs'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = resolve(import.meta.dirname, '../../../..')
  const crateRoot = join(repoRoot, 'native', 'windows-cli-launcher')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  const output = readArg('--output') ?? join(crateRoot, '.build', 'orca.exe')
  for (const binName of ['orca', 'orca-administrator-restart', 'orca-portable-updater']) {
    const label =
      binName === 'orca'
        ? 'Windows CLI launcher'
        : binName === 'orca-administrator-restart'
          ? 'Windows administrator restart launcher'
          : 'Windows portable updater'
    compileWindowsRustExecutable({
      repoRoot,
      crateRoot,
      binName,
      label,
      fingerprintInputs: [
        join(crateRoot, 'src', 'administrator_status.rs'),
        join(crateRoot, 'src', 'administrator_restart.rs'),
        join(crateRoot, 'src', 'administrator_launcher.rs'),
        join(crateRoot, 'src', 'portable_authenticode.rs'),
        join(crateRoot, 'src', 'portable_updater.rs'),
        join(crateRoot, 'src', 'portable_updater_launcher.rs'),
        iconPath,
        join(repoRoot, 'config/scripts/native-build/windows/build-windows-cli-launcher.mjs')
      ],
      arch: readArg('--arch'),
      outputPath: binName === 'orca' ? output : join(dirname(output), `${binName}.exe`),
      buildEnv: (version) => ({
        ORCA_LAUNCHER_VERSION: version,
        ORCA_LAUNCHER_ICON: iconPath,
        ORCA_LAUNCHER_FILENAME: `${binName}.exe`
      })
    })
  }
}
