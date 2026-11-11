import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { prepareStandaloneDevMenuBar } from './dev-menu-bar.mjs'

it('provisions stock launches without overwriting an existing helper when its sources change', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-menu-bar-dev-'))
  const env = {}
  const source = path.join(root, 'native/menu-bar-macos/main.swift')
  try {
    for (const file of [
      'native/menu-bar-macos/main.swift',
      'config/scripts/native-build/macos/build-menu-bar-macos.mjs',
      'config/scripts/native-build/macos/swift-cli-helper-macos.mjs'
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), 'source revision one')
    }
    const build = ({ appPath }) => {
      mkdirSync(path.join(appPath, 'Contents/MacOS'), { recursive: true })
      writeFileSync(path.join(appPath, 'Contents/MacOS/orca-menu-bar'), 'native owner')
      writeFileSync(path.join(appPath, 'Contents/Info.plist'), 'own identity')
    }
    const options = { root, env, platform: 'darwin', build, signApp: () => {} }
    prepareStandaloneDevMenuBar(true, options)
    const first = env.ORCA_DEV_MENU_BAR_EXECUTABLE
    expect(readFileSync(first, 'utf8')).toBe('native owner')
    writeFileSync(first, 'already running helper')
    prepareStandaloneDevMenuBar(true, {
      ...options,
      build: () => {
        throw new Error('Must reuse completed bundle')
      }
    })
    expect(readFileSync(env.ORCA_DEV_MENU_BAR_EXECUTABLE, 'utf8')).toBe('already running helper')
    writeFileSync(source, 'source revision two')
    expect(() =>
      prepareStandaloneDevMenuBar(true, {
        ...options,
        signApp: () => {
          throw new Error('Signing failed')
        }
      })
    ).toThrow('Signing failed')
    prepareStandaloneDevMenuBar(true, options)
    expect(env.ORCA_DEV_MENU_BAR_EXECUTABLE).not.toBe(first)
    expect(readFileSync(env.ORCA_DEV_MENU_BAR_EXECUTABLE, 'utf8')).toBe('native owner')
    expect(readFileSync(first, 'utf8')).toBe('already running helper')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
