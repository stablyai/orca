import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { countTestTypeErrors } from './check-e2e-typecheck-ratchet.mjs'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { runE2eTypecheck } from './run-e2e-typecheck.mjs'

const ROOT = process.cwd()
const resolveBunExecutable = () => resolvePinnedBunExecutable(ROOT, runProcessSync)
const directories = []
const diagnostic = 'tests/entry.ts(1,1): error TS2322: Type error.\n'

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-e2e-check-'))
  directories.push(root)
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'tests'))
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(
    join(root, 'config', 'tsconfig.e2e.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'Node20',
        moduleResolution: 'Node16',
        target: 'ES2022',
        strict: true,
        types: []
      },
      include: ['../tests/**/*.ts']
    })
  )
  writeFileSync(join(root, 'tests', 'exports.ts'), 'export const value = 1\n')
  writeFileSync(
    join(root, 'tests', 'entry.ts'),
    "import { missing } from './exports'\nexport const value: number = 'wrong'\n"
  )
  return root
}

it('captures all diagnostics using the pinned Bun and all available CPU cores', () => {
  const execute = vi.fn(() => ({ code: 1, stdout: diagnostic, stderr: 'summary' }))
  expect(runE2eTypecheck({ execute, resolveBunExecutable: () => 'pinned-bun' })).toEqual({
    code: 1,
    output: `${diagnostic}summary`
  })
  expect(execute).toHaveBeenCalledWith({
    program: 'pinned-bun',
    args: [
      'check',
      '-p',
      'config/tsconfig.e2e.json',
      '--threads',
      String(availableParallelism()),
      '--no-pretty',
      '--all'
    ],
    cwd: ROOT,
    timeoutMs: null,
    maxOutputBytes: 64 * 1024 * 1024
  })
})

it.each([
  { code: 1, stdout: '', stderr: 'failed to start' },
  { code: null, stdout: diagnostic, signal: 'SIGKILL' },
  { code: 0, stdout: diagnostic, timedOut: true },
  { code: 1, stdout: diagnostic, outputTruncated: true },
  { code: 99, stdout: diagnostic },
  { code: null, stdout: diagnostic }
])('rejects failed or incomplete checks before the ratchet can prune errors: %j', (result) => {
  expect(() =>
    runE2eTypecheck({
      execute: () => result,
      resolveBunExecutable: () => 'pinned-bun'
    })
  ).toThrow('failed to run')
})

it('does not run when Bun is missing or the project compiler version has drifted', () => {
  const execute = vi.fn()
  expect(() => runE2eTypecheck({ execute, resolveBunExecutable: () => null })).toThrow('missing')
  const root = fixture()
  mkdirSync(join(root, 'config', 'node_modules', 'typescript'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'node_modules', 'typescript', 'package.json'),
    JSON.stringify({ version: '0.0.0', bin: { tsc: './bin/tsc' } })
  )
  expect(() =>
    runE2eTypecheck({
      root,
      execute,
      resolveBunExecutable: () => 'pinned-bun'
    })
  ).toThrow('resolves 0.0.0')
  expect(execute).not.toHaveBeenCalled()
})

it('keeps real missing-export and type-error diagnostics identical to TypeScript', () => {
  const root = fixture()
  const native = runE2eTypecheck({ root, compiler: 'native' })
  const bun = runE2eTypecheck({ root, resolveBunExecutable })
  const locations = (output) =>
    [...output.matchAll(/^.+\(\d+,\d+\): error TS\d+:/gm)].map(([line]) => line).sort()
  expect(locations(bun.output)).toEqual(locations(native.output))
  expect(locations(bun.output)).toHaveLength(2)
  expect(countTestTypeErrors(bun.output)).toEqual(new Map([['tests/entry.ts', 2]]))
  writeFileSync(join(root, 'tests', 'entry.ts'), "export { value } from './exports'\n")
  expect(runE2eTypecheck({ root, resolveBunExecutable }).code).toBe(0)
  expect(runE2eTypecheck({ root, compiler: 'native' }).code).toBe(0)
})
