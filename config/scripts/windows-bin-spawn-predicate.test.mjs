import { describe, expect, it } from 'vitest'
import { hasNodeModulesBinSpawn } from './windows-bin-spawn-predicate.mjs'

describe('node_modules bin spawn predicate', () => {
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'])(
    'catches %s through local aliases',
    (method) => {
      expect(
        hasNodeModulesBinSpawn(`
      const bin = path.join(root, 'node_modules', '.bin', 'oxfmt')
      const program = bin
      cp.${method}(program, ['--write', file])
    `)
      ).toBe(true)
    }
  )

  it.each([
    "path.resolve(root, 'node_modules/.bin/oxfmt')",
    '`' + '${root}/node_modules/.bin/oxfmt' + '`',
    "root + '/node_modules/' + '.bin/oxfmt'",
    "'C:\\\\repo\\\\node_modules\\\\.bin\\\\oxfmt'",
    "enabled ? 'node_modules/.bin/oxfmt' : 'oxfmt'"
  ])('catches the path expression %s', (expression) => {
    expect(hasNodeModulesBinSpawn(`execFileSync(${expression}, [])`)).toBe(true)
  })

  it.each([
    "// spawnSync('node_modules/.bin/oxfmt', [])",
    'const example = "spawnSync(\'node_modules/.bin/oxfmt\', [])"',
    "const bin = path.join(root, 'node_modules', '.bin', 'oxfmt'); existsSync(bin)",
    "spawnSync(process.execPath, ['node_modules/.bin/oxfmt'])",
    "spawnSync('node_modules/.binary/oxfmt', [])",
    "spawnSync('other_node_modules/.bin/oxfmt', [])",
    `const invocation = resolveOxcCliInvocation('oxfmt', 'oxfmt', root)
     execFileSync(invocation.command, [...invocation.prefixArgs, '--write', file])`,
    'const a = b; const b = a; spawnSync(a, [])'
  ])('does not flag non-program paths or safe invocations: %s', (contents) => {
    expect(hasNodeModulesBinSpawn(contents)).toBe(false)
  })
})
