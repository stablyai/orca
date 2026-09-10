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
const RESOLVED_GYP = "require.resolve('node-addon-api/node_addon_api.gyp')"

describe('windows-process-tree node-addon-api gyp path', () => {
  it('stages headers without a pnpm-sensitive gyp dependency', () => {
    expect(PATCH).not.toContain('+        "../../node-addon-api')
    expect(PATCH).toContain('+          "include_dirs": ["deps/node-addon-api"],')
    expect(PATCH).toContain('+          "defines": ["NAPI_CPP_EXCEPTIONS", "_HAS_EXCEPTIONS=1"],')
    const buildScript = readFileSync(
      join(projectDir, 'config/scripts/build-windows-process-tree-relay-addon.mjs'),
      'utf8'
    )
    expect(buildScript).toContain('stageWindowsProcessTreeNodeAddonApiHeaders(PACKAGE_DIR)')
    expect(buildScript).toContain('Repaired un-applied pnpm patch hunks before build.')
    const rebuildHelper = readFileSync(
      join(projectDir, 'config/scripts/windows-process-tree-gyp-rebuild.mjs'),
      'utf8'
    )
    expect(rebuildHelper).toContain("createRequire(join(packageDir, 'package.json'))")
    expect(rebuildHelper).toContain("resolve('node-addon-api/package.json')")
    expect(rebuildHelper).toContain("'napi.h'")
    expect(rebuildHelper).toContain("'napi-inl.h'")
    expect(rebuildHelper).toContain("'napi-inl.deprecated.h'")
    const rebuildScript = readFileSync(
      join(projectDir, 'config/scripts/rebuild-native-deps.mjs'),
      'utf8'
    )
    expect(rebuildScript).toContain('stageWindowsProcessTreeNodeAddonApiHeaders()')
  })

  it('resolves node_addon_api.gyp to a real file from the package directory', () => {
    const resolved = execFileSync(process.execPath, ['-p', RESOLVED_GYP], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8'
    }).trim()
    expect(isAbsolute(resolved)).toBe(true)
    expect(existsSync(resolved)).toBe(true)
  })
})
