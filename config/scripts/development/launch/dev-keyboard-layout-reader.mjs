import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { buildMacNativeAddon } = require('../../desktop-distribution/macos/macos-native-addon.cjs')

const DEV_KEYBOARD_LAYOUT_ADDON = 'orca_keyboard_layout.node'
const SOURCE_DIR = path.resolve(import.meta.dirname, '../../../../native/keyboard-layout-macos')

/** Identifies the reader source so a dev bundle is rebuilt when it changes. */
export function hashDevKeyboardLayoutSource() {
  const hash = createHash('sha1')
  // Old checkouts keep the retired helper's .build/ here; only source files identify the reader.
  for (const entry of readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(`${entry.name}\0`).update(readFileSync(path.join(SOURCE_DIR, entry.name)))
  }
  return hash.digest('hex')
}

/** A failed build only degrades keyboard behavior and keeps the bundle; a source change or deleting the bundle retries it. */
export function buildDevKeyboardLayoutReader(resourcesDir) {
  try {
    buildMacNativeAddon({
      nativeDir: 'keyboard-layout-macos',
      addon: DEV_KEYBOARD_LAYOUT_ADDON,
      outputDir: resourcesDir,
      arch: process.arch
    })
  } catch (error) {
    console.warn(
      `[orca-dev] keyboard layout reader build failed (shifted Option composition stays conservative; to retry, quit this dev instance and delete ${path.resolve(resourcesDir, '../../..')}): ${error?.message ?? error}`
    )
  }
}
