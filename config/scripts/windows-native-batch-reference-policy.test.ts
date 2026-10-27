import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasWindowsNativeBatchReferenceViolation } from './windows-native-batch-reference-policy'

const initializer = 'config/scripts/initialize-windows-native-toolchain.mjs'
const benchmark = 'config/scripts/benchmark-windows-native-preparation.mjs'
const observer = 'config/scripts/windows-native-benchmark-observer.mjs'
const metadataCallers = [
  'config/scripts/node-server-change-scope.mjs',
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/orcad-windows-prebuild-cache.mjs',
  'config/scripts/windows-native-toolchain-routing.test.mjs'
]
const capture = 'capture-windows-native-environment.cmd'
const initializerSource = `
  import { runProcessSync as captureEnvironment } from '@orca/process-host'
  const devcmd = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')
  existsSync(devcmd)
  captureEnvironment({
    program: join(import.meta.dirname, '${capture}'),
    env: { ORCA_WINDOWS_VSDEVCMD: devcmd }
  })
`
const benchmarkSource = `
  import { runProcess } from '@orca/process-host'
  const source = 'config/scripts/${capture}'
  await runProcess({ program: process.execPath, args: [source] })
`

function hasViolation(relativePath: string, contents: string): boolean {
  const literals = [...contents.matchAll(/['"][\w./\\-]*\.(?:cmd|bat)['"]/gi)].map((match) =>
    match[0].slice(1, -1)
  )
  return hasWindowsNativeBatchReferenceViolation(relativePath, contents, literals)
}

describe('reviewed Windows native batch references', () => {
  it.each([...metadataCallers, initializer, benchmark, observer])(
    'accepts the current reviewed source in %s',
    (relativePath) => {
      const root = path.resolve(import.meta.dirname, '..', '..')
      expect(hasViolation(relativePath, readFileSync(path.join(root, relativePath), 'utf8'))).toBe(
        false
      )
    }
  )

  it.each(metadataCallers)('allows the fixed source path as metadata in %s', (relativePath) => {
    expect(hasViolation(relativePath, `const source = 'config/scripts/${capture}'`)).toBe(false)
  })

  it('accepts the process-host executor through its imported alias', () => {
    expect(hasViolation(initializer, initializerSource)).toBe(false)
  })

  it('accepts the benchmark executor', () => {
    expect(hasViolation(benchmark, benchmarkSource)).toBe(false)
  })

  it.each([
    'config/scripts/other-native-preparation.mjs',
    'tests/tools/initialize-windows-native-toolchain.mjs',
    `config/scripts/nested/${path.basename(initializer)}`
  ])('rejects the fixed runner in another caller: %s', (relativePath) => {
    expect(hasViolation(relativePath, initializerSource)).toBe(true)
  })

  it.each([
    'elsewhere/capture-windows-native-environment.cmd',
    './capture-windows-native-environment.cmd',
    'CAPTURE-WINDOWS-NATIVE-ENVIRONMENT.cmd',
    'other.cmd',
    'other.bat'
  ])('rejects another batch path in a reviewed executor: %s', (literal) => {
    expect(hasViolation(initializer, `${initializerSource}\nconst other = '${literal}'`)).toBe(true)
  })

  it.each(metadataCallers)('rejects other batch metadata in %s', (relativePath) => {
    expect(
      hasViolation(relativePath, `const sources = ['config/scripts/${capture}', 'other.cmd']`)
    ).toBe(true)
    expect(hasViolation(relativePath, `const command = 'VsDevCmd.bat'`)).toBe(true)
  })

  it.each([
    [initializer, initializerSource],
    [benchmark, benchmarkSource],
    [observer, `require('@orca/process-host'); const capture = '${capture}'`]
  ])('rejects a missing process-host load in %s', (relativePath, contents) => {
    expect(hasViolation(relativePath, contents.replace('@orca/process-host', 'other-runner'))).toBe(
      true
    )
  })

  it('rejects an unused process-host import beside an unverified executor', () => {
    expect(
      hasViolation(initializer, initializerSource.replace('captureEnvironment({', 'otherRunner({'))
    ).toBe(true)
  })

  it('rejects another executor for the fixed capture script beside a valid call', () => {
    expect(
      hasViolation(
        initializer,
        `${initializerSource}\notherRunner({ program: join(import.meta.dirname, '${capture}') })`
      )
    ).toBe(true)
  })

  it.each([
    "import { spawnSync as execute } from 'node:child_process'",
    "import * as cp from 'child_process'",
    "await import('node:child_process')",
    "const builtins = 'node:child_process'; process.getBuiltinModule(builtins)",
    "const require = createRequire(import.meta.url); const cp = require('child_process')"
  ])('rejects raw child-process module loads: %s', (load) => {
    expect(hasViolation(initializer, `${initializerSource}\n${load}`)).toBe(true)
  })

  it.each([
    "spawn('program', [])",
    "cp.spawnSync('program', [])",
    "cp['execFile']('program', [])",
    "execFileSync('program', [])",
    "exec('program')",
    "execSync('program')",
    "fork('program')"
  ])('rejects raw process calls: %s', (call) => {
    expect(hasViolation(initializer, `${initializerSource}\n${call}`)).toBe(true)
  })

  it.each([
    "runProcess({ program: 'node_modules/.bin/pnpm' })",
    "const bin = join(root, 'node_modules', '.bin', 'pnpm'); runProcess({ program: bin })",
    "runProcess({ program: join(root, 'node_modules', 'tools', '..', '.bin', 'pnpm') })",
    "const spec = { 'program': 'root\\\\node_modules\\\\.bin\\\\pnpm' }; runProcess(spec)",
    "const program = join(root, 'node_modules', '.bin', 'pnpm'); runProcess({ program })",
    "runProcess({ ['program']: join(root, 'node_modules', '.bin', 'pnpm') })"
  ])('rejects package-bin programs through process-host: %s', (call) => {
    expect(hasViolation(benchmark, `${benchmarkSource}\n${call}`)).toBe(true)
  })

  it.each(metadataCallers)('rejects process execution added to metadata in %s', (relativePath) => {
    expect(
      hasViolation(
        relativePath,
        `const capture = 'config/scripts/${capture}'; runProcess({ program: capture })`
      )
    ).toBe(true)
    expect(
      hasViolation(
        relativePath,
        `import { runProcess as execute } from '@orca/process-host'; const capture = 'config/scripts/${capture}'; execute({ program: capture })`
      )
    ).toBe(true)
  })

  it.each([
    "captureEnvironment({ program: 'VsDevCmd.bat' })",
    'captureEnvironment({ program: devcmd })',
    'const program = devcmd; captureEnvironment({ program })',
    "const devcmd = join(other, 'VsDevCmd.bat')"
  ])('keeps the discovered developer command as metadata: %s', (extra) => {
    expect(hasViolation(initializer, `${initializerSource}\n${extra}`)).toBe(true)
  })
})
