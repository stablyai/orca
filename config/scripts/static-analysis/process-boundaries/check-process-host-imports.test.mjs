import { describe, expect, it } from 'vitest'
import { assessProcessHostImports } from './check-process-host-imports.mjs'

const file = 'src/main/process-consumer.ts'
const manifest = { exports: { '.': './dist/index.js' } }
const assess = (source) => assessProcessHostImports(new Map([[file, source]]), manifest, new Set())

describe('process-host runtime import boundary', () => {
  it.each([
    "import type { ChildProcess } from 'node:child_process'",
    "import type * as ChildProcess from 'child_process'",
    "import type ChildProcess = require('node:child_process')",
    "export type { ChildProcess } from 'node:child_process'",
    "type Child = import('node:child_process').ChildProcess"
  ])('allows erased Node type ownership: %s', (source) => {
    expect(assess(source)).toMatchObject({ direct: [], added: [], violations: [] })
  })

  it.each([
    "import { spawn } from 'node:child_process'",
    "import 'child_process'",
    "import { type ChildProcess } from 'node:child_process'",
    "export { spawn } from 'node:child_process'",
    "const child = require('node:child_process')",
    "const child = import('node:child_process')",
    "import type { ChildProcess } from 'node:child_process'; require('node:child_process')",
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('node:child_process')",
    "process.getBuiltinModule('child_process')"
  ])('still rejects runtime access: %s', (source) => {
    expect(assess(source)).toMatchObject({ direct: [file], added: [file] })
  })

  it('keeps package export restrictions for type-only imports', () => {
    expect(assess("import type { Private } from '@orca/process-host/private'").violations).toEqual([
      `${file}: @orca/process-host/private is not a public process-host export`
    ])
  })

  it('requires the WSL allowlist only for runtime child-process imports', () => {
    const wsl = "const program = 'wsl.exe'"
    expect(
      assess(`import type { ChildProcess } from 'node:child_process'; ${wsl}`).violations
    ).toEqual([])
    expect(assess(`import { spawn } from 'node:child_process'; ${wsl}`).violations).toEqual([
      `${file}: direct wsl.exe exec must call assertWslDistroAllowed`
    ])
  })
})
