import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const pluginPath = path.resolve('config/oxlint-plugins/mobile-pairing-qrcode-import.mjs')
// Why the package entry rather than `.bin/oxlint`: Node refuses to spawn a .cmd
// without a shell, and the .bin shim on Windows is one. Running the same script
// the shim runs needs no shell at all, so no argument has to survive quoting.
const oxlintEntry = path.resolve('node_modules/oxlint/bin/oxlint')

function lintSource(source) {
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-qrcode-import-lint-'))
  const sourcePath = path.join(directory, 'sample.ts')
  const configPath = path.join(directory, 'oxlint.json')
  writeFileSync(sourcePath, source)
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [{ name: 'mobile-pairing', specifier: pluginPath }],
      rules: { 'mobile-pairing/no-eager-qrcode-import': 'error' }
    })
  )
  const result = spawnSync(
    process.execPath,
    [oxlintEntry, '--config', configPath, '--format', 'json', sourcePath],
    { encoding: 'utf8' }
  )
  if (result.error) {
    throw result.error
  }
  return JSON.parse(result.stdout).diagnostics
}

describe('mobile pairing qrcode import rule', () => {
  it('rejects eager runtime imports', () => {
    const diagnostics = lintSource("import QRCode from 'qrcode'\nvoid QRCode")

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'mobile-pairing(no-eager-qrcode-import)'
    ])
  })

  it('allows type-only and lazy imports', () => {
    expect(lintSource("import type QRCode from 'qrcode'\nlet qr: typeof QRCode")).toEqual([])
    expect(lintSource("const QRCode = await import('qrcode')\nvoid QRCode")).toEqual([])
  })
})
