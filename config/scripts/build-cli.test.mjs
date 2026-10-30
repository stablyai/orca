import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess, runProcessSync } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { buildCli } from './build-cli.mjs'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { resolveProjectCompiler } from './run-typecheck-projects-in-parallel.mjs'
import { supportsTsrs } from './tsrs-typecheck-compiler.mjs'

const ROOT = process.cwd()
const resolveBunExecutable = () => resolvePinnedBunExecutable(ROOT, runProcessSync)
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-build-'))
  directories.push(root)
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'src'))
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(join(root, 'config', '.bun-version'), readFileSync('config/.bun-version'))
  writeFileSync(
    join(root, 'config', 'tsconfig.build.cli.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'Node20',
        moduleResolution: 'Node16',
        target: 'ES2022',
        strict: true,
        types: [],
        rootDir: '../src',
        declaration: true,
        declarationMap: true,
        sourceMap: true
      },
      include: ['../src/**/*.ts']
    })
  )
  writeFileSync(join(root, 'src', 'constants.ts'), 'export const enum Mode { Ready = 7 }\n')
  writeFileSync(
    join(root, 'src', 'entry.ts'),
    `import { Mode } from './constants'
export interface Item { value: number }
export const item: Item = { value: Mode.Ready }
`
  )
  return root
}

it('checks the emit project first, retains all CPU cores and preserves the TypeScript emitter', async () => {
  const order = []
  const check = vi.fn(async () => {
    order.push('check')
    return []
  })
  const execute = vi.fn(async () => {
    order.push('emit')
    return { code: 0 }
  })
  await buildCli({ check, execute, resolveBunExecutable: () => 'pinned-bun' })
  expect(order).toEqual(['check', 'emit'])
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      compiler: 'bun',
      bunExecutable: 'pinned-bun',
      projects: [{ config: 'config/tsconfig.build.cli.json', heapGib: 2 }],
      bunThreads: availableParallelism()
    })
  )
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      program: process.execPath,
      args: [
        resolveProjectCompiler('config/tsconfig.build.cli.json'),
        '-p',
        'config/tsconfig.build.cli.json',
        '--outDir',
        'out',
        '--composite',
        'false',
        '--incremental',
        'false',
        '--noCheck'
      ]
    })
  )
})

it('does not emit when checking fails or the pinned Bun is missing', async () => {
  const execute = vi.fn()
  await expect(
    buildCli({
      check: async () => [new Error('type error')],
      execute,
      resolveBunExecutable: () => 'pinned-bun'
    })
  ).rejects.toThrow('type error')
  await expect(buildCli({ execute, resolveBunExecutable: () => null })).rejects.toThrow(
    'run pnpm install'
  )
  expect(execute).not.toHaveBeenCalled()
})

it('propagates emitter failures', async () => {
  await expect(
    buildCli({
      check: async () => [],
      resolveBunExecutable: () => 'pinned-bun',
      execute: async () => ({ code: null, signal: 'SIGKILL' })
    })
  ).rejects.toThrow('signal=SIGKILL')
})

it('rejects unknown compiler selections before emission', async () => {
  const execute = vi.fn()
  await expect(buildCli({ compiler: 'unknown', execute })).rejects.toThrow(
    'Invalid ORCA_CLI_BUILD_COMPILER'
  )
  expect(execute).not.toHaveBeenCalled()
})

it('produces byte-identical JavaScript, declarations and maps with the real compilers', async () => {
  const root = fixture()
  const baseline = await runProcess({
    program: process.execPath,
    args: [
      resolveProjectCompiler('config/tsconfig.build.cli.json', root),
      '-p',
      'config/tsconfig.build.cli.json',
      '--outDir',
      'baseline',
      '--composite',
      'false',
      '--incremental',
      'false'
    ],
    cwd: root
  })
  expect(baseline.code, baseline.stdout + baseline.stderr).toBe(0)
  await buildCli({ root, outDir: 'optimized', resolveBunExecutable })
  const files = readdirSync(join(root, 'baseline')).sort()
  expect(readdirSync(join(root, 'optimized')).sort()).toEqual(files)
  expect(files).toHaveLength(8)
  for (const file of files) {
    expect(
      readFileSync(join(root, 'optimized', file)).equals(
        readFileSync(join(root, 'baseline', file))
      ),
      file
    ).toBe(true)
  }
})

it('blocks output for real type errors and rejects compiler version drift', async () => {
  const root = fixture()
  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value: number = "wrong"\n')
  const execute = vi.fn()
  await expect(buildCli({ root, execute, resolveBunExecutable })).rejects.toThrow(
    'exited with code 1'
  )
  expect(execute).not.toHaveBeenCalled()

  const drift = fixture()
  rmSync(join(drift, 'node_modules'))
  mkdirSync(join(drift, 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(
    join(drift, 'node_modules', 'typescript', 'package.json'),
    JSON.stringify({
      name: 'typescript',
      version: '99.0.0',
      bin: { tsc: 'compiler.cjs' }
    })
  )
  await expect(buildCli({ root: drift, execute, resolveBunExecutable })).rejects.toThrow(
    'resolves 99.0.0'
  )
  expect(execute).not.toHaveBeenCalled()
})

it.skipIf(!supportsTsrs())(
  'the optional compiler preserves emitted bytes and blocks output on type errors',
  async () => {
    const root = fixture()
    await buildCli({ root, outDir: 'baseline', compiler: 'bun', resolveBunExecutable })
    await buildCli({ root, outDir: 'optimized', compiler: 'tsrs' })
    const files = readdirSync(join(root, 'baseline')).sort()
    expect(readdirSync(join(root, 'optimized')).sort()).toEqual(files)
    for (const file of files) {
      expect(
        readFileSync(join(root, 'optimized', file)).equals(
          readFileSync(join(root, 'baseline', file))
        ),
        file
      ).toBe(true)
    }
    writeFileSync(join(root, 'src', 'entry.ts'), 'export const value: number = "wrong"\n')
    await expect(buildCli({ root, outDir: 'failed', compiler: 'tsrs' })).rejects.toThrow(
      'CLI compilation failed'
    )
    expect(existsSync(join(root, 'failed'))).toBe(false)
  }
)
