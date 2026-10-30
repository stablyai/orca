import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const PACKAGE_DIR = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
const RESOLVED_GYP = "require.resolve('node-addon-api/node_addon_api.gyp')"

describe('windows-process-tree node-addon-api gyp path', () => {
  // The installed Windows dependency is exercised by the Windows CI lane.
  it.runIf(process.platform === 'win32')(
    'resolves node_addon_api.gyp to a real file from the package directory',
    () => {
      const resolved = execFileSync(process.execPath, ['-p', RESOLVED_GYP], {
        cwd: PACKAGE_DIR,
        encoding: 'utf8'
      }).trim()
      expect(isAbsolute(resolved)).toBe(true)
      expect(existsSync(resolved)).toBe(true)
    }
  )
})
