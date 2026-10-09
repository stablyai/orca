/**
 * Stage the prebuilt `@vscode/windows-process-tree` addon into a Windows relay bundle.
 *
 * Every desktop package ships relays for every host OS, so a macOS or Linux build
 * needs the addon a Windows job compiled: without it a Windows SSH host cannot
 * launch the relay outside sshd's job as a standard user. Release builds list the
 * arches they require; a local build without the addon ships the scan fallback.
 */
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RELAY_WINDOWS_PROCESS_TREE_FILENAME,
  isWindowsRelayPlatform
} from '../../src/shared/relay-artifacts.ts'
import { relayWindowsProcessTreeAddonDefect } from './windows-process-tree-gyp-rebuild.mjs'

/** `ORCA_REQUIRE_RELAY_NATIVE_ADDONS`: comma-separated arches, or `all`. */
export function parseRequiredRelayAddonArches(value) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * @param {{
 *   platform: string,
 *   outDir: string,
 *   buildDir: string,
 *   requiredArches: string[],
 *   log?: (message: string) => void
 * }} options
 * @returns {'staged' | 'skipped' | 'not-windows'}
 */
export function stageRelayWindowsProcessTreeAddon({
  platform,
  outDir,
  buildDir,
  requiredArches,
  log = console.log
}) {
  if (!isWindowsRelayPlatform(platform)) {
    return 'not-windows'
  }
  const arch = platform.slice('win32-'.length)
  const source = join(buildDir, arch, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  const required = requiredArches.includes(arch) || requiredArches.includes('all')
  const defect = relayWindowsProcessTreeAddonDefect(source, arch)
  if (defect) {
    const reason = `${source}: ${defect}`
    if (required) {
      throw new Error(
        `Relay ${platform} needs ${RELAY_WINDOWS_PROCESS_TREE_FILENAME}, but ${reason}. ` +
          `On Windows run: node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=${arch}. ` +
          'CI builds on other OSes download it from the relay-windows-process-tree artifact.'
      )
    }
    // Never ship a defective binary: the scan fallback beats a relay that loads the wrong addon.
    log(`Relay ${platform}: ${reason}; relay will use the PowerShell scan.`)
    return 'skipped'
  }
  copyFileSync(source, join(outDir, RELAY_WINDOWS_PROCESS_TREE_FILENAME))
  return 'staged'
}
