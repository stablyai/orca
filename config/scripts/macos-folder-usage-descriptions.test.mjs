import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  MACOS_FOLDER_USAGE_DESCRIPTIONS,
  applyMacHelperFolderUsageDescriptions
} = require('./macos-folder-usage-descriptions.cjs')
const config = require('../electron-builder.config.cjs')

it('uses the same three folder descriptions for the app and every packaged Electron Helper', () => {
  expect(config.mac.extendInfo).toMatchObject(MACOS_FOLDER_USAGE_DESCRIPTIONS)
  expect(Object.keys(MACOS_FOLDER_USAGE_DESCRIPTIONS)).toHaveLength(3)
  const root = mkdtempSync(join(tmpdir(), 'orca-helper-privacy-'))
  try {
    const names = [
      'Orca Dev Helper.app',
      'Orca Dev Helper (GPU).app',
      'Orca Dev Helper (Renderer).app',
      'Orca Dev Helper (Plugin).app',
      'Orca Computer.app'
    ]
    for (const name of names) {
      const contents = join(root, 'Contents', 'Frameworks', name, 'Contents')
      mkdirSync(contents, { recursive: true })
      writeFileSync(
        join(contents, 'Info.plist'),
        JSON.stringify({ CFBundleIdentifier: name, preserved: true })
      )
    }
    const run = vi.fn((_program, args) =>
      args.includes('json') ? readFileSync(args.at(-1), 'utf8') : ''
    )
    applyMacHelperFolderUsageDescriptions(root, 'Orca Dev', run)
    for (const name of names.slice(0, 4)) {
      expect(
        JSON.parse(
          readFileSync(join(root, 'Contents', 'Frameworks', name, 'Contents', 'Info.plist'), 'utf8')
        )
      ).toEqual({ CFBundleIdentifier: name, preserved: true, ...MACOS_FOLDER_USAGE_DESCRIPTIONS })
    }
    expect(run).toHaveBeenCalledTimes(8)
    expect(
      JSON.parse(
        readFileSync(
          join(root, 'Contents', 'Frameworks', names[4], 'Contents', 'Info.plist'),
          'utf8'
        )
      )
    ).not.toHaveProperty('NSDesktopFolderUsageDescription')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
