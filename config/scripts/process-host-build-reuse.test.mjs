import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageDir = resolve('src/packages/process-host')
const require = createRequire(join(packageDir, 'package.json'))
const compilerDir = dirname(require.resolve('typescript/package.json'))
const { buildPackageDist } = await import(
  pathToFileURL(join(packageDir, 'scripts', 'build-dist.mjs')).href
)
const roots = []
const stateFile = '.dist-build-state.json'

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-process-host-reuse-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  const compiler = join(root, 'node_modules', 'typescript')
  mkdirSync(join(compiler, 'bin'), { recursive: true })
  writeFileSync(join(compiler, 'package.json'), readFileSync(join(compilerDir, 'package.json')))
  symlinkSync(join(compilerDir, 'lib'), join(compiler, 'lib'), 'junction')
  const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`
  const nativeDir = dirname(require.resolve(`${nativeName}/package.json`))
  mkdirSync(join(root, 'node_modules', '@typescript'))
  symlinkSync(nativeDir, join(root, 'node_modules', nativeName), 'junction')
  writeFileSync(
    join(compiler, 'bin', 'tsc'),
    `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runProcess } from ${JSON.stringify(pathToFileURL(require.resolve('@orca/process-host')).href)}
appendFileSync('.compiler-invocations', 'compile\\n')
if (existsSync('.compiler-input-edit')) {
  writeFileSync('src/entry.ts', readFileSync('.compiler-input-edit'))
  rmSync('.compiler-input-edit')
}
const result = await runProcess({
  program: process.execPath,
  args: [${JSON.stringify(join(compilerDir, 'bin', 'tsc'))}, ...process.argv.slice(2)],
  cwd: process.cwd(),
  timeoutMs: 120_000
})
if (existsSync('.compiler-input-restore')) {
  writeFileSync('src/entry.ts', readFileSync('.compiler-input-restore'))
  rmSync('.compiler-input-restore')
}
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.code ?? 1
`
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@orca/process-host' }))
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        rootDir: 'src',
        outDir: 'dist',
        declaration: true,
        noEmitOnError: true,
        types: []
      },
      include: ['src/**/*.ts']
    })
  )
  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 1\n')
  return root
}

function compilationCount(root) {
  return readFileSync(join(root, '.compiler-invocations'), 'utf8').trim().split('\n').length
}

function updateConfig(root, mutate) {
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  mutate(config)
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(config))
}

describe('process-host compilation reuse', () => {
  it('compiles once across repeated and concurrent unchanged builds', async () => {
    const root = fixture()
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(1)

    const repeated = await Promise.all([buildPackageDist(root), buildPackageDist(root)])

    expect(compilationCount(root)).toBe(1)
    expect(repeated).toEqual([
      { written: 0, removed: 0, unchanged: 2 },
      { written: 0, removed: 0, unchanged: 2 }
    ])
    mkdirSync(join(root, '.dist-staging-abandoned'))
    await buildPackageDist(root)
    expect(existsSync(join(root, '.dist-staging-abandoned'))).toBe(false)
    expect(compilationCount(root)).toBe(1)
  })

  it('recompiles changed sources, new sources, configuration, and manifests', async () => {
    const root = fixture()
    await buildPackageDist(root)
    writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 2\n')
    await buildPackageDist(root)
    expect(readFileSync(join(root, 'dist', 'entry.js'), 'utf8')).toContain('value = 2')
    writeFileSync(join(root, 'src', 'added.ts'), 'export const added = true\n')
    await buildPackageDist(root)
    expect(existsSync(join(root, 'dist', 'added.js'))).toBe(true)
    rmSync(join(root, 'src', 'added.ts'))
    await buildPackageDist(root)
    expect(existsSync(join(root, 'dist', 'added.js'))).toBe(false)
    updateConfig(root, (config) => {
      config.compilerOptions.sourceMap = true
    })
    await buildPackageDist(root)
    expect(existsSync(join(root, 'dist', 'entry.js.map'))).toBe(true)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@orca/process-host', version: '1' })
    )
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(6)
  })

  it('repairs missing, corrupt, and extra output and malformed build state', async () => {
    const root = fixture()
    await buildPackageDist(root)
    const emitted = readFileSync(join(root, 'dist', 'entry.js'), 'utf8')
    rmSync(join(root, 'dist', 'entry.js'))
    await buildPackageDist(root)
    expect(readFileSync(join(root, 'dist', 'entry.js'), 'utf8')).toBe(emitted)
    writeFileSync(join(root, 'dist', 'entry.js'), 'corrupt')
    await buildPackageDist(root)
    expect(readFileSync(join(root, 'dist', 'entry.js'), 'utf8')).toBe(emitted)
    writeFileSync(join(root, 'dist', 'stale.js'), 'stale')
    await buildPackageDist(root)
    expect(existsSync(join(root, 'dist', 'stale.js'))).toBe(false)
    writeFileSync(join(root, stateFile), '{partial')
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(5)
  })

  it('does not reuse inherited configurations', async () => {
    const root = fixture()
    const config = readFileSync(join(root, 'tsconfig.json'), 'utf8')
    writeFileSync(join(root, 'base.json'), config)
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json' }))
    await buildPackageDist(root)
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(2)
    expect(existsSync(join(root, stateFile))).toBe(false)
  })

  it('does not reuse a graph that reaches declarations outside the hashed roots', async () => {
    const root = fixture()
    writeFileSync(join(root, 'outside.d.ts'), 'type ExternalValue = number\n')
    writeFileSync(
      join(root, 'src', 'entry.ts'),
      '/// <reference path="../outside.d.ts" />\nexport const value: ExternalValue = 1\n'
    )
    await buildPackageDist(root)
    expect(existsSync(join(root, stateFile))).toBe(false)
    writeFileSync(join(root, 'outside.d.ts'), 'type ExternalValue = string\n')
    await expect(buildPackageDist(root)).rejects.toThrow('compilation failed')
    expect(compilationCount(root)).toBe(2)
  })

  it('does not reuse a configuration that permits installed libraries to replace native libs', async () => {
    const root = fixture()
    updateConfig(root, (config) => {
      config.compilerOptions.libReplacement = true
    })
    writeFileSync(join(root, 'src', 'entry.ts'), 'export const value: string = document.title\n')
    await buildPackageDist(root)
    expect(existsSync(join(root, stateFile))).toBe(false)
    const replacement = join(root, 'node_modules', '@typescript', 'lib-dom')
    mkdirSync(replacement, { recursive: true })
    writeFileSync(
      join(replacement, 'package.json'),
      JSON.stringify({ name: '@typescript/lib-dom', types: 'index.d.ts' })
    )
    writeFileSync(join(replacement, 'index.d.ts'), 'declare const document: { title: number }\n')
    await expect(buildPackageDist(root)).rejects.toThrow('compilation failed')
    expect(compilationCount(root)).toBe(2)
  })

  it('invalidates changed compiler contents even at the same version', async () => {
    const root = fixture()
    const local = join(root, 'node_modules', 'typescript')
    await buildPackageDist(root)
    await buildPackageDist(root)
    const bin = join(local, 'bin', 'tsc')
    writeFileSync(bin, `${readFileSync(bin, 'utf8')}\n// compiler changed\n`)
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(2)
  })

  it('invalidates changes to the Node and transitive declaration inputs', async () => {
    const root = fixture()
    const nodeTypes = join(root, 'node_modules', '@types', 'node')
    const undici = join(root, 'node_modules', 'undici-types')
    mkdirSync(nodeTypes, { recursive: true })
    mkdirSync(undici)
    writeFileSync(
      join(nodeTypes, 'package.json'),
      JSON.stringify({
        name: '@types/node',
        types: 'index.d.ts',
        dependencies: { 'undici-types': '*' }
      })
    )
    writeFileSync(
      join(undici, 'package.json'),
      JSON.stringify({ name: 'undici-types', types: 'index.d.ts' })
    )
    writeFileSync(
      join(nodeTypes, 'index.d.ts'),
      "/// <reference path='../../undici-types/index.d.ts' />\n"
    )
    writeFileSync(join(undici, 'index.d.ts'), 'declare const fixtureNodeValue: number\n')
    updateConfig(root, (config) => {
      config.compilerOptions.types = ['node']
    })
    await buildPackageDist(root)
    await buildPackageDist(root)
    writeFileSync(join(undici, 'index.d.ts'), 'declare const fixtureNodeValue: string\n')
    await buildPackageDist(root)
    writeFileSync(join(nodeTypes, 'index.d.ts'), 'declare const changedNodeValue: boolean\n')
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(3)
  })

  it('does not cache a failed build or inputs changed during compilation', async () => {
    const root = fixture()
    await buildPackageDist(root)
    const entry = join(root, 'src', 'entry.ts')
    writeFileSync(entry, 'export const value: number = "bad"\n')
    await expect(buildPackageDist(root)).rejects.toThrow('compilation failed')
    expect(existsSync(join(root, stateFile))).toBe(false)
    writeFileSync(entry, 'export const value = 2\n')
    writeFileSync(join(root, '.compiler-input-edit'), 'export const value = 3\n')
    await buildPackageDist(root)
    expect(existsSync(join(root, stateFile))).toBe(false)
    await buildPackageDist(root)
    await buildPackageDist(root)
    expect(compilationCount(root)).toBe(4)
  })

  it('recompiles when source changes and returns to its original contents during compilation', async () => {
    const root = fixture()
    writeFileSync(join(root, '.compiler-input-edit'), 'export const value = 2\n')
    writeFileSync(join(root, '.compiler-input-restore'), 'export const value = 1\n')

    await buildPackageDist(root)

    expect(readFileSync(join(root, 'dist', 'entry.js'), 'utf8')).toContain('value = 2')
    expect(readFileSync(join(root, 'src', 'entry.ts'), 'utf8')).toContain('value = 1')
    expect(existsSync(join(root, stateFile))).toBe(false)

    await buildPackageDist(root)
    await buildPackageDist(root)

    expect(readFileSync(join(root, 'dist', 'entry.js'), 'utf8')).toContain('value = 1')
    expect(compilationCount(root)).toBe(2)
  })
})
