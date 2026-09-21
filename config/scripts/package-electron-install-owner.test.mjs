import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')
const packageJson = JSON.parse(readProject('package.json'))
const pnpmWorkspace = parse(readProject('pnpm-workspace.yaml'))

const OWNED_ELECTRON_REBUILD = 'node config/scripts/rebuild-native-deps.mjs'
// Why exact tokens and not /electron/i or a substring: the owner's own path has no "electron"
// in it, so a keyword check waves a duplicated rebuild through -- the case this contract is
// named for (#20787). Substring matching has the opposite fault: `install-app-deps` would also
// reject a `check-install-app-deps-version.mjs` that installs nothing. `rebuild:electron` is
// package.json's alias for the owned script, so running it is the same takeover.
const ELECTRON_INSTALL_COMMANDS = [
  OWNED_ELECTRON_REBUILD,
  'config/scripts/rebuild-native-deps.mjs',
  'rebuild:electron',
  'electron-rebuild',
  'electron-builder',
  'install-app-deps'
]
const tokenize = (step) => step.split(/[\s]+/).flatMap((word) => [word, ...word.split(/[@]/)])
const takesOverElectronInstall = (step) => {
  if (step.includes(OWNED_ELECTRON_REBUILD)) {
    return true
  }
  const tokens = new Set(tokenize(step))
  return ELECTRON_INSTALL_COMMANDS.some((command) => tokens.has(command))
}

describe('Electron binary install ownership', () => {
  it('keeps root postinstall as the single Electron binary install owner', () => {
    // The invariant is that the root postinstall owns the Electron binary install, not that
    // nothing may run after it -- pinning the whole string broke every open PR (#20726).
    const steps = packageJson.scripts.postinstall.split('&&').map((step) => step.trim())
    expect(steps[0]).toBe(OWNED_ELECTRON_REBUILD)
    for (const step of steps.slice(1)) {
      expect(takesOverElectronInstall(step)).toBe(false)
    }
    expect(pnpmWorkspace.allowBuilds).not.toHaveProperty('electron')
  })

  // Why a separate case: the assertion above only reads the real postinstall, so it cannot show
  // a bad chain would be caught. #20787 shipped a keyword check that missed a duplicated
  // rebuild; these fixtures pin the rejections themselves.
  it('rejects a chained step that would take over the Electron install', () => {
    expect(takesOverElectronInstall(OWNED_ELECTRON_REBUILD)).toBe(true)
    expect(takesOverElectronInstall('npx electron-rebuild')).toBe(true)
    expect(takesOverElectronInstall('npx electron-builder install-app-deps')).toBe(true)
    expect(takesOverElectronInstall('node config/scripts/sync-anti-slop-plugin.mjs')).toBe(false)
    expect(takesOverElectronInstall('node config/scripts/check-electron-version.mjs')).toBe(false)
    expect(takesOverElectronInstall('pnpm run rebuild:electron')).toBe(true)
    expect(takesOverElectronInstall('node config/scripts/check-install-app-deps-version.mjs')).toBe(
      false
    )
  })
})
