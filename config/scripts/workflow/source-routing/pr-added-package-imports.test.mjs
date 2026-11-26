import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addsPackageImport } from './pr-added-package-imports.mjs'

const root = mkdtempSync(join(tmpdir(), 'pr-added-package-imports-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const isTestFile = (file) => file.endsWith('.test.ts')

/** The router's own full-context diff format, from real git, for one file. */
function routes(before, after, file = 'src/main/x.ts') {
  const sides = ['old', 'new'].map((side, index) => {
    const path = join(side, file)
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), [before, after][index])
    return path
  })
  const { stdout } = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--unified=1000000',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      ...sides
    ],
    { cwd: root, encoding: 'utf8' }
  )
  return addsPackageImport(stdout, isTestFile)
}

const base =
  "import { join } from 'node:path'\nimport type { Thing } from 'zod'\n\nexport const x = 1\n"

describe('addsPackageImport', () => {
  it('routes a package load the file did not have, however it is written', () => {
    for (const added of [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js'",
      "import 'side-effect-package'",
      "export * from 'ajv'",
      "import {\n  parse,\n  stringify\n} from 'smol-toml'",
      'const mod = await import(\n  "jsonc-parser"\n)',
      "const sdk = requireFromMain('@linear/sdk')",
      "const root = require.resolve('node-pty/package.json')",
      "const ssh = createRequire(__filename)('ssh2')"
    ]) {
      expect(routes(base, `${base}${added}\n`), added).toBe(true)
    }
  })

  it('routes a type-only import made a runtime one, even with no specifier line changed', () => {
    const before = "import {\n  type LinearClient,\n  type Issue\n} from '@linear/sdk'\n"
    const after =
      "import {\n  LinearClient,\n  type Issue\n} from '@linear/sdk'\nnew LinearClient()\n"
    expect(routes(before, after)).toBe(true)
  })

  it('ignores loads the file already had, builtins, Electron, relative and type-only imports, and tests', () => {
    const with_ = `${base}import { z } from 'zod/v4'\n`
    expect(routes(with_, `${with_}const more = z.string()\n`)).toBe(false)
    const ignored = [
      "import { spawn } from 'child_process'",
      "import { app } from 'electron'",
      "import { a } from './local'",
      "import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'",
      "import { type A, type B } from 'yaml'",
      "export type { Thing } from 'zod'",
      "import { vi } from 'vitest'",
      '++ not a header'
    ].join('\n')
    expect(routes(base, `${base}${ignored}\n`)).toBe(false)
    expect(routes(base, `${base}import { x } from 'ajv'\n`, 'src/main/x.test.ts')).toBe(false)
  })
})
