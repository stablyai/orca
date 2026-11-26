#!/usr/bin/env node
// Symlink orca-dev into /usr/local/bin after build:cli for global dev access.
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const scriptDir = import.meta.dirname
const source = path.join(scriptDir, '../launch/orca-dev.mjs')

const commandPath =
  process.platform === 'darwin' || process.platform === 'linux' ? '/usr/local/bin/orca-dev' : null

if (!commandPath) {
  console.log('[orca-dev] Skipping global symlink (unsupported platform).')
  process.exit(0)
}

function isDanglingSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink() && !existsSync(target)
  } catch {
    return false
  }
}

function isOwnedByUs(target) {
  try {
    if (!lstatSync(target).isSymbolicLink()) {
      return false
    }
    return readlinkSync(target) === source
  } catch {
    return false
  }
}

// existsSync follows the link, so a link to a removed checkout reads as absent and `ln` then fails.
if (isDanglingSymlink(commandPath)) {
  console.error(
    `[orca-dev] ${commandPath} points to ${readlinkSync(commandPath)}, which no longer exists, so orca-dev runs nothing. Point it at this checkout with:\n` +
      `  sudo ln -sf ${source} ${commandPath}`
  )
  process.exit(0)
}

if (existsSync(commandPath)) {
  if (isOwnedByUs(commandPath)) {
    console.log(`[orca-dev] ${commandPath} already points to dev CLI.`)
    process.exit(0)
  }
  console.error(
    `[orca-dev] ${commandPath} exists but is not our symlink. Remove it manually if you want the dev CLI installed globally.`
  )
  process.exit(0)
}

try {
  execFileSync('ln', ['-s', source, commandPath], { stdio: 'inherit' })
  console.log(`[orca-dev] Symlinked ${commandPath} → ${source}`)
} catch {
  console.log(
    `[orca-dev] Could not create ${commandPath} (permission denied). Run once with:\n` +
      `  sudo ln -s ${source} ${commandPath}`
  )
}
