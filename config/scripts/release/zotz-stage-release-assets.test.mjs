import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageZotzReleaseAssets } from './zotz-stage-release-assets.mjs'

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('stageZotzReleaseAssets', () => {
  it('keeps the names the manifest uses and adds the human-named copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'zotz-stage-'))
    directories.push(root)
    const out = join(root, 'release')
    for (const [name, contents] of [
      [
        'latest.yml',
        'version: 1.4.21401\nfiles:\n  - url: orca-windows-setup.exe\n    sha512: x\npath: orca-windows-setup.exe\n'
      ],
      ['orca-windows-setup.exe', 'exe'],
      ['orca-windows-setup.exe.blockmap', 'map'],
      ['builder-debug.yml', 'ignored']
    ]) {
      writeFileSync(join(root, name), contents)
    }
    stageZotzReleaseAssets({
      distDir: root,
      outDir: out,
      humanCopies: 'orca-windows-setup.exe=zotz-windows-x64-setup.exe'
    })
    expect(readdirSync(out).sort()).toEqual([
      'latest.yml',
      'orca-windows-setup.exe',
      'orca-windows-setup.exe.blockmap',
      'zotz-windows-x64-setup.exe'
    ])
  })
})
