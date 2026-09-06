import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export function linkEmulatorMacKeychain(
  homeDir,
  { platform = process.platform, realHome = os.homedir() } = {}
) {
  if (platform !== 'darwin') {
    return null
  }
  const source = path.join(realHome, 'Library', 'Keychains')
  if (!existsSync(source)) {
    return null
  }
  const target = path.join(homeDir, 'Library', 'Keychains')
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) {
      const linkedSource = path.resolve(path.dirname(target), readlinkSync(target))
      if (linkedSource === path.resolve(source)) {
        return target
      }
    }
    throw new Error(`Refusing to replace emulator Keychain path: ${target}`)
  }
  symlinkSync(source, target, 'dir')
  return target
}
