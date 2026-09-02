import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const {
  extendMacElectronNodeHostInfoPlist,
  macTerminalProtectedFolderUsageDescriptions
} = require('../mac-electron-node-host-privacy.cjs')

async function createInfoPlist(path, bundleId) {
  await mkdir(join(path, 'Contents'), { recursive: true })
  await writeFile(
    join(path, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleIdentifier</key>',
      `  <string>${bundleId}</string>`,
      '</dict>',
      '</plist>'
    ].join('\n'),
    'utf8'
  )
}

describe('macOS Electron Node host privacy', () => {
  it('keeps protected-folder purposes identical in the main app and terminal host', () => {
    expect(electronBuilderConfig.mac.extendInfo).toMatchObject(
      macTerminalProtectedFolderUsageDescriptions
    )
  })

  it.skipIf(process.platform !== 'darwin')(
    'adds protected-folder purposes only to the generic Electron helper',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-electron-node-host-privacy-'))
      const appPath = join(root, 'Orca.app')
      const genericHelper = join(appPath, 'Contents', 'Frameworks', 'Orca Helper.app')
      const rendererHelper = join(appPath, 'Contents', 'Frameworks', 'Orca Helper (Renderer).app')
      try {
        await createInfoPlist(genericHelper, 'com.stablyai.orca.helper')
        await createInfoPlist(rendererHelper, 'com.stablyai.orca.helper.Renderer')

        const updatedPath = extendMacElectronNodeHostInfoPlist(appPath, 'Orca')

        expect(updatedPath).toBe(join(genericHelper, 'Contents', 'Info.plist'))
        const genericInfo = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', updatedPath], {
            encoding: 'utf8'
          })
        )
        const rendererInfo = JSON.parse(
          execFileSync(
            '/usr/bin/plutil',
            ['-convert', 'json', '-o', '-', join(rendererHelper, 'Contents', 'Info.plist')],
            { encoding: 'utf8' }
          )
        )
        expect(genericInfo.CFBundleIdentifier).toBe('com.stablyai.orca.helper')
        expect(genericInfo).toMatchObject(macTerminalProtectedFolderUsageDescriptions)
        expect(rendererInfo).not.toMatchObject(macTerminalProtectedFolderUsageDescriptions)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('fails packaging when the generic Electron helper is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-electron-node-host-missing-'))
    try {
      expect(() => extendMacElectronNodeHostInfoPlist(join(root, 'Orca.app'), 'Orca')).toThrow(
        /Missing Electron Node host Info\.plist/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
