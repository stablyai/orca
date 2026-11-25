import { describe, expect, it } from 'vitest'
import { addsPackageImport } from './pr-added-package-imports.mjs'

const isTestFile = (file) => file.endsWith('.test.ts')
const diffAdding = (file, ...lines) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,0 +1 @@',
    ...lines.map((l) => `+${l}`)
  ].join('\n')

describe('addsPackageImport', () => {
  it('routes runtime loads of a package, however they are written', () => {
    for (const line of [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js'",
      "import 'side-effect-package'",
      "export * from 'zod'",
      "} from '@orca/process-host'",
      "  const ajv = require('ajv')",
      "  const mod = await import('smol-toml')",
      "  return requireFromMain('@linear/sdk')",
      "  const root = require.resolve('node-pty/package.json')"
    ]) {
      expect(addsPackageImport(diffAdding('src/main/x.ts', line), isTestFile), line).toBe(true)
    }
  })

  it('ignores builtins, Electron, relative paths, type-only imports and test files', () => {
    const diff = [
      diffAdding(
        'src/cli/x.ts',
        "import { join } from 'node:path'",
        "import { spawn } from 'child_process'",
        "import { app } from 'electron'",
        "import { a } from './local'",
        "import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'",
        "export type { Thing } from 'zod'",
        "const s = 'not an import from zod'",
        'import {',
        '  a,',
        "} from './added-whole'"
      ),
      diffAdding('src/shared/x.test.ts', "import { describe } from 'zod'"),
      diffAdding('src/main/testing/fixture.ts', "import { vi } from 'vitest'")
    ].join('\n')
    expect(addsPackageImport(diff, isTestFile)).toBe(false)
  })

  it('routes a multi-line type import made a runtime one, whose `} from` line is unchanged', () => {
    const diff = [
      'diff --git a/src/main/ssh.ts b/src/main/ssh.ts',
      '--- a/src/main/ssh.ts',
      '+++ b/src/main/ssh.ts',
      '@@ -1 +1 @@',
      '-import type {',
      '+import {',
      '@@ -9,0 +10 @@',
      '+  const client = new SshClient()'
    ].join('\n')
    expect(addsPackageImport(diff, isTestFile)).toBe(true)
  })
})
