import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it } from 'vitest'
const { packageWindowsWerHelper } = createRequire(import.meta.url)(
  './package-windows-wer-helper.cjs'
)
let directory
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-wer-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('preserves the helper bytes under the packaged executable name and tolerates builder renaming', () => {
  writeFileSync(join(directory, 'electron_wer.dll'), 'helper')
  packageWindowsWerHelper(directory, 'Orca')
  expect(readFileSync(join(directory, 'Orca_wer.dll'), 'utf8')).toBe('helper')
  packageWindowsWerHelper(directory, 'Orca')
})
it('fails packaging when the crash reporting helper is absent', () => {
  expect(() => packageWindowsWerHelper(directory, 'Orca')).toThrow(
    'Missing Electron Windows Error Reporting helper'
  )
})
