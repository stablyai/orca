import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const PATCH = readFileSync(
  join(projectDir, 'config/patches/@vscode__windows-process-tree@0.8.0.patch'),
  'utf8'
)
const PACKAGE_DIR = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
const ABSOLUTE_GYP = "require.resolve('node-addon-api/node_addon_api.gyp')"

describe('windows-process-tree node-addon-api gyp path', () => {
  it('keeps the gyp project path absolute so pnpm Windows source builds find it', () => {
    expect(PATCH).toContain(
      `+        "<!(node -p \\"require.resolve('node-addon-api/node_addon_api.gyp')\\"):node_addon_api_except"`
    )
    const bindingGyp = readFileSync(join(PACKAGE_DIR, 'binding.gyp'), 'utf8')
    expect(bindingGyp).toContain(ABSOLUTE_GYP)
    expect(bindingGyp).not.toContain("require('node-addon-api').targets")
    expect(
      readFileSync(
        join(projectDir, 'config/scripts/build-windows-process-tree-relay-addon.mjs'),
        'utf8'
      )
    ).toContain(ABSOLUTE_GYP)
  })

  it('resolves node_addon_api.gyp to a real file from the package directory', () => {
    const resolved = execFileSync(process.execPath, ['-p', ABSOLUTE_GYP], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8'
    }).trim()
    expect(isAbsolute(resolved)).toBe(true)
    expect(existsSync(resolved)).toBe(true)
  })
})
