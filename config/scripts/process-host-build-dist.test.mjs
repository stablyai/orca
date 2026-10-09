import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'

const realPackageDir = resolve('src/packages/process-host')
const buildScript = join(realPackageDir, 'scripts', 'build-dist.mjs')
const packageRequire = createRequire(join(realPackageDir, 'package.json'))
const tsxCli = packageRequire.resolve('tsx/cli')
const realCompilerDir = dirname(packageRequire.resolve('typescript/package.json'))
const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const temporaryRoots = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const packageDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-process-host-build-')))
  temporaryRoots.push(packageDir)
  mkdirSync(join(packageDir, 'src'))
  mkdirSync(join(packageDir, 'node_modules'))
  symlinkSync(realCompilerDir, join(packageDir, 'node_modules', 'typescript'), 'junction')
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture' }))
  writeFileSync(
    join(packageDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        rootDir: 'src',
        outDir: 'dist',
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        noEmitOnError: true,
        types: []
      },
      include: ['src/**/*.ts']
    })
  )
  writeFileSync(join(packageDir, 'src', 'entry.ts'), "export { value } from './internal'\n")
  writeFileSync(join(packageDir, 'src', 'internal.ts'), 'export const value = 1\n')
  return packageDir
}

function runBuild(packageDir, { script = buildScript, cwd = realPackageDir } = {}) {
  const args = [tsxCli, '--conditions=orca-source', script, ...(packageDir ? [packageDir] : [])]
  return runProcess({ program: nodeExecutable, args, cwd, timeoutMs: 120_000 })
}

// Emits replacement output, then takes over or deletes the build lock as a competing build would.
function installLockStealingCompiler(packageDir, { recreateLock }) {
  const compilerDir = join(packageDir, 'node_modules', 'typescript')
  rmSync(compilerDir, { recursive: true })
  mkdirSync(join(compilerDir, 'bin'), { recursive: true })
  writeFileSync(
    join(compilerDir, 'package.json'),
    JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } })
  )
  writeFileSync(
    join(compilerDir, 'bin', 'tsc'),
    `const { mkdirSync, rmSync, utimesSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const outDir = process.argv[process.argv.indexOf('--outDir') + 1]
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'entry.js'), 'module.exports = "from a build that lost its lock"')
writeFileSync(join(outDir, 'added.js'), '')
rmSync('.dist-build.lock', { recursive: true, force: true })
${recreateLock ? "mkdirSync('.dist-build.lock')\nconst foreignMtime = new Date(Date.now() + 60_000)\nutimesSync('.dist-build.lock', foreignMtime, foreignMtime)" : ''}
// Hold compilation past proper-lockfile's 15-second refresh so compromise is observed.
setTimeout(() => {}, 17_000)
`
  )
}

async function build(packageDir) {
  const result = await runBuild(packageDir)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  return result
}

function distSnapshot(packageDir) {
  const distDir = join(packageDir, 'dist')
  return Object.fromEntries(
    readdirSync(distDir)
      .sort()
      .map((file) => {
        const stat = statSync(join(distDir, file))
        return [file, { ino: stat.ino, mtimeMs: stat.mtimeMs }]
      })
  )
}

function leftovers(packageDir) {
  return readdirSync(packageDir).filter((name) => name.startsWith('.dist-'))
}

describe('process-host dist build', () => {
  it('leaves an up-to-date dist untouched on repeated builds', async () => {
    const packageDir = fixture()
    await build(packageDir)
    const before = distSnapshot(packageDir)

    const repeated = await build(packageDir)

    expect(repeated.stdout).toBe('')
    expect(distSnapshot(packageDir)).toEqual(before)
    expect(leftovers(packageDir)).toEqual([])
  })

  it('rewrites only changed outputs and keeps source maps pointing at src', async () => {
    const packageDir = fixture()
    await build(packageDir)
    const before = distSnapshot(packageDir)

    writeFileSync(join(packageDir, 'src', 'internal.ts'), 'export const value = 2\n')
    const changed = await build(packageDir)

    expect(changed.stdout).toContain('2 written, 0 removed, 6 unchanged')
    const after = distSnapshot(packageDir)
    for (const file of ['entry.js', 'entry.d.ts', 'internal.js.map']) {
      expect(after[file]).toEqual(before[file])
    }
    expect(after['internal.js']).not.toEqual(before['internal.js'])
    const map = JSON.parse(readFileSync(join(packageDir, 'dist', 'internal.js.map'), 'utf8'))
    expect(map.sources).toEqual(['../src/internal.ts'])
  })

  it('removes outputs of renamed sources', async () => {
    const packageDir = fixture()
    await build(packageDir)
    renameSync(join(packageDir, 'src', 'internal.ts'), join(packageDir, 'src', 'renamed.ts'))
    writeFileSync(join(packageDir, 'src', 'entry.ts'), "export { value } from './renamed'\n")

    await build(packageDir)

    expect(readdirSync(join(packageDir, 'dist')).sort()).toEqual([
      'entry.d.ts',
      'entry.d.ts.map',
      'entry.js',
      'entry.js.map',
      'renamed.d.ts',
      'renamed.d.ts.map',
      'renamed.js',
      'renamed.js.map'
    ])
  })

  it('preserves the previous dist when compilation fails', async () => {
    const packageDir = fixture()
    await build(packageDir)
    const before = distSnapshot(packageDir)
    writeFileSync(join(packageDir, 'src', 'internal.ts'), "export const value: number = 'bad'\n")

    const failed = await runBuild(packageDir)

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('compilation failed')
    expect(distSnapshot(packageDir)).toEqual(before)
    expect(leftovers(packageDir)).toEqual([])
  })

  it('publishes new dependencies before replacing their importer and removes stale output last', async () => {
    const packageDir = fixture()
    await build(packageDir)
    renameSync(join(packageDir, 'src', 'internal.ts'), join(packageDir, 'src', 'z-new.ts'))
    writeFileSync(join(packageDir, 'src', 'z-new.ts'), 'export const value = 2\n')
    writeFileSync(join(packageDir, 'src', 'entry.ts'), "export { value } from './z-new'\n")
    const script = join(packageDir, 'read-during-publication.mjs')
    const observation = join(packageDir, 'publication-read.json')
    const entry = join(packageDir, 'dist', 'entry.js')
    const oldDependency = join(packageDir, 'dist', 'internal.js')
    // Pause immediately after replacing the importer; the owned reader exits before publication resumes.
    writeFileSync(
      script,
      `import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const rename = fs.renameSync
fs.renameSync = (source, target) => {
  const result = rename(source, target)
  if (target === ${JSON.stringify(entry)}) {
    const reader = spawnSync(process.execPath, ['-e', ${JSON.stringify(
      `console.log(JSON.stringify({ value: require(${JSON.stringify(entry)}).value, oldDependencyExists: require('node:fs').existsSync(${JSON.stringify(oldDependency)}) }))`
    )}], { encoding: 'utf8', timeout: 10_000 })
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ code: reader.status, stdout: reader.stdout, stderr: reader.stderr }))
  }
  return result
}
syncBuiltinESMExports()
const { buildPackageDist } = await import(${JSON.stringify(pathToFileURL(buildScript).href)})
await buildPackageDist(process.argv[2])
`
    )

    const result = await runBuild(packageDir, { script })

    expect(result).toMatchObject({ code: 0, stderr: '' })
    const reader = JSON.parse(readFileSync(observation, 'utf8'))
    expect(reader).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(reader.stdout)).toEqual({ value: 2, oldDependencyExists: true })
    expect(existsSync(oldDependency)).toBe(false)
    expect(leftovers(packageDir)).toEqual([])
  })

  it('keeps dist loadable while concurrent builds and a reader run', async () => {
    const packageDir = fixture()
    await build(packageDir)
    writeFileSync(
      join(packageDir, 'src', 'internal.ts'),
      `export const value = ${'2 + '.repeat(10_000)}2\n`
    )
    const entry = join(packageDir, 'dist', 'entry.js')
    const finished = join(packageDir, 'builds-finished')
    const reader = runProcess({
      program: nodeExecutable,
      args: [
        '-e',
        `const { existsSync } = require('node:fs')
let reads = 0
while (!existsSync(${JSON.stringify(finished)}) || reads === 0) {
  for (const key of Object.keys(require.cache)) delete require.cache[key]
  if (typeof require(${JSON.stringify(entry)}).value !== 'number') process.exit(2)
  reads += 1
}`
      ],
      timeoutMs: 60_000
    })

    let builds
    let read
    try {
      builds = await Promise.all([1, 2, 3].map(() => runBuild(packageDir)))
    } finally {
      writeFileSync(finished, '')
      read = await reader
    }

    expect(builds.map((result) => [result.code, result.stderr])).toEqual(builds.map(() => [0, '']))
    expect(read).toMatchObject({ code: 0, stderr: '' })
    expect(readFileSync(join(packageDir, 'dist', 'internal.js'), 'utf8')).toContain('2 + 2')
    expect(leftovers(packageDir)).toEqual([])
  })

  it('serializes builds so a later source snapshot is the one published', async () => {
    const packageDir = fixture()
    await build(packageDir)
    // Hold the build lock while the source changes, as an in-flight earlier build would.
    mkdirSync(join(packageDir, '.dist-build.lock'))
    const waiting = runBuild(packageDir)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    writeFileSync(join(packageDir, 'src', 'internal.ts'), 'export const value = 9\n')
    rmSync(join(packageDir, '.dist-build.lock'), { recursive: true })

    expect(await waiting).toMatchObject({ code: 0, stderr: '' })
    expect(readFileSync(join(packageDir, 'dist', 'internal.js'), 'utf8')).toContain('value = 9')
  })

  it.each([
    ['taken over by another build', true],
    ['removed', false]
  ])(
    'fails without publishing when the held build lock is %s',
    async (_label, recreateLock) => {
      const packageDir = fixture()
      await build(packageDir)
      const before = distSnapshot(packageDir)
      const entry = readFileSync(join(packageDir, 'dist', 'entry.js'), 'utf8')
      installLockStealingCompiler(packageDir, { recreateLock })

      const result = await runBuild(packageDir)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('build lock was compromised')
      expect(distSnapshot(packageDir)).toEqual(before)
      expect(readFileSync(join(packageDir, 'dist', 'entry.js'), 'utf8')).toBe(entry)
      // The other build's lock is left in place.
      expect(existsSync(join(packageDir, '.dist-build.lock'))).toBe(recreateLock)
      expect(leftovers(packageDir).filter((name) => name.startsWith('.dist-staging-'))).toEqual([])
    },
    30_000
  )

  it('reclaims staging directories abandoned by a killed build', async () => {
    const packageDir = fixture()
    mkdirSync(join(packageDir, '.dist-staging-abandoned'))
    writeFileSync(join(packageDir, '.dist-staging-abandoned', 'partial.js'), '')

    await build(packageDir)

    expect(existsSync(join(packageDir, 'dist', 'entry.js'))).toBe(true)
    expect(existsSync(join(packageDir, 'dist', 'partial.js'))).toBe(false)
    expect(leftovers(packageDir)).toEqual([])
  })

  it('compiles with the package-local TypeScript', async () => {
    const packageDir = fixture()
    rmSync(join(packageDir, 'node_modules', 'typescript'))
    const localCompilerDir = join(packageDir, 'node_modules', 'typescript')
    mkdirSync(join(localCompilerDir, 'bin'), { recursive: true })
    writeFileSync(
      join(localCompilerDir, 'package.json'),
      JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } })
    )
    writeFileSync(
      join(localCompilerDir, 'bin', 'tsc'),
      "require('node:fs').writeFileSync('compiled-by', 'package')\nprocess.exit(1)\n"
    )

    const failed = await runBuild(packageDir)

    expect(failed.code).toBe(1)
    expect(readFileSync(join(packageDir, 'compiled-by'), 'utf8')).toBe('package')
  })

  it('builds its own package when reached through a symlinked directory', async () => {
    const packageDir = fixture()
    mkdirSync(join(packageDir, 'scripts'))
    copyFileSync(buildScript, join(packageDir, 'scripts', 'build-dist.mjs'))
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@orca/process-host',
        exports: { '.': { 'orca-source': './src/run-process.ts' } }
      })
    )
    // The script imports runProcess through its own package name; forward to the real one.
    writeFileSync(
      join(packageDir, 'src', 'run-process.ts'),
      `export { runProcess } from ${JSON.stringify(join(realPackageDir, 'src', 'run-process.ts'))}\n`
    )
    writeFileSync(
      join(packageDir, 'tsconfig.json'),
      readFileSync(join(packageDir, 'tsconfig.json'), 'utf8').replace(
        '"include":["src/**/*.ts"]',
        '"include":["src/entry.ts","src/internal.ts"]'
      )
    )
    symlinkSync(
      dirname(packageRequire.resolve('proper-lockfile/package.json')),
      join(packageDir, 'node_modules', 'proper-lockfile'),
      'junction'
    )
    const linkRoot = mkdtempSync(join(tmpdir(), 'orca-process-host-link-'))
    temporaryRoots.push(linkRoot)
    const linkDir = join(linkRoot, 'package')
    symlinkSync(packageDir, linkDir, 'junction')

    const result = await runBuild(undefined, {
      script: join(linkDir, 'scripts', 'build-dist.mjs'),
      cwd: linkDir
    })

    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(existsSync(join(packageDir, 'dist', 'entry.js'))).toBe(true)
  })
})
