import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PROC_INFO_ADDON_BUILD_PATH,
  assertProcInfoAddonBuilt
} = require('../proc-info-macos-resources.cjs')

// electron-builder Arch enum: x64=1, arm64=3, universal=4.
const X64 = 1
const ARM64 = 3

describe('assertProcInfoAddonBuilt', () => {
  let scratch
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-guard-'))
  })
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('ignores every platform but macOS', () => {
    expect(() => assertProcInfoAddonBuilt('linux', X64, scratch)).not.toThrow()
    expect(() => assertProcInfoAddonBuilt('win32', X64, scratch)).not.toThrow()
  })

  it('fails macOS packaging when the addon was never built', () => {
    expect(() => assertProcInfoAddonBuilt('darwin', ARM64, scratch)).toThrow(
      'pnpm run build:proc-info-macos'
    )
  })

  it.runIf(process.platform === 'darwin')(
    'fails a slice whose architecture the addon lacks',
    () => {
      const output = join(scratch, PROC_INFO_ADDON_BUILD_PATH)
      mkdirSync(dirname(output), { recursive: true })
      execFileSync(
        process.execPath,
        ['config/scripts/build-proc-info-macos.mjs', '--single-arch', '--output', output],
        { stdio: 'inherit' }
      )
      const host = process.arch === 'arm64' ? ARM64 : X64
      const other = process.arch === 'arm64' ? X64 : ARM64
      expect(() => assertProcInfoAddonBuilt('darwin', host, scratch)).not.toThrow()
      expect(() => assertProcInfoAddonBuilt('darwin', other, scratch)).toThrow('lacks')
    },
    120_000
  )
})
