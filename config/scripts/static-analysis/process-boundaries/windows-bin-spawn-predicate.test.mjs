import { describe, expect, it } from 'vitest'
import { hasNodeModulesBinSpawn } from './windows-bin-spawn-predicate.mjs'

describe('node_modules bin spawn predicate', () => {
  it('folds dot segments, so a .. detour into node_modules/.bin is still caught', () => {
    expect(
      hasNodeModulesBinSpawn(
        "import { execFileSync } from 'node:child_process'\n" +
          "import path from 'node:path'\n" +
          "execFileSync(path.join(root, 'node_modules', 'tools', '..', '.bin', 'oxfmt'), [])\n"
      )
    ).toBe(true)
  })

  it('folds Windows-separator dot segments too', () => {
    expect(
      hasNodeModulesBinSpawn(
        "import { execFileSync } from 'node:child_process'\n" +
          "execFileSync('root\\\\node_modules\\\\tools\\\\..\\\\.bin\\\\oxfmt', [])\n"
      )
    ).toBe(true)
  })

  it('does not fold a .. back into .bin when it escapes the directory', () => {
    expect(
      hasNodeModulesBinSpawn(
        "import { execFileSync } from 'node:child_process'\n" +
          "import path from 'node:path'\n" +
          "execFileSync(path.join(root, 'node_modules', '.bin', '..', 'oxfmt', 'cli.js'), [])\n"
      )
    ).toBe(false)
  })
})
