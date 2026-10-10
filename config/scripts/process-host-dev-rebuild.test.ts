import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { rolldown, watch } from 'rolldown'
import type { Plugin, RolldownWatcher } from 'rolldown'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessHostDevRebuildPlugin } from '../build-plugins/process-host-dev-rebuild'

const realPackageDir = resolve('src/packages/process-host')
const temporaryRoots: string[] = []
const watchers: RolldownWatcher[] = []

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()))
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(): { root: string; packageDir: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-process-host-dev-'))
  temporaryRoots.push(root)
  const packageDir = join(root, 'src', 'packages', 'process-host')
  const sourceDir = join(packageDir, 'src')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(join(packageDir, 'scripts'))
  // Runs the real package build against this fixture package.
  writeFileSync(
    join(packageDir, 'scripts', 'build-dist.mjs'),
    `const { buildPackageDist } = await import(${JSON.stringify(pathToFileURL(resolve(realPackageDir, 'scripts', 'build-dist.mjs')).href)})\nawait buildPackageDist(${JSON.stringify(packageDir)})\n`
  )
  mkdirSync(join(root, 'node_modules', '@orca'), { recursive: true })
  const packageRequire = createRequire(join(realPackageDir, 'package.json'))
  for (const tool of ['typescript', 'tsx']) {
    symlinkSync(
      dirname(packageRequire.resolve(`${tool}/package.json`)),
      join(root, 'node_modules', tool),
      'junction'
    )
  }
  symlinkSync(packageDir, join(root, 'node_modules', '@orca', 'process-host'), 'junction')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - src/packages/*\n')
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@orca/process-host',
      type: 'commonjs',
      exports: { '.': { 'orca-source': './src/entry.ts', default: './dist/entry.js' } }
    })
  )
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { strict: true } })
  )
  writeFileSync(
    join(packageDir, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../../tsconfig.base.json',
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        rootDir: 'src',
        outDir: 'dist',
        noEmitOnError: true,
        types: []
      },
      include: ['src/**/*.ts']
    })
  )
  writeFileSync(join(sourceDir, 'entry.ts'), "export { version } from './internal'\n")
  writeFileSync(join(sourceDir, 'internal.ts'), '// preserved comment\nexport const version = 1\n')
  const main = join(root, 'main.cjs')
  writeFileSync(main, "module.exports = require('@orca/process-host')\n")
  return { root, packageDir, main }
}

function nextEvent(watcher: RolldownWatcher, code: 'END' | 'ERROR'): Promise<void> {
  return new Promise((resolveEvent, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${code}`)), 15_000)
    watcher.on('event', function listener(event) {
      if (event.code === code) {
        clearTimeout(timeout)
        watcher.off('event', listener)
        resolveEvent()
      } else if (event.code === 'ERROR' && code !== 'ERROR') {
        clearTimeout(timeout)
        watcher.off('event', listener)
        reject(event.error)
      }
    })
  })
}

function closeSuccessfulBundles(watcher: RolldownWatcher): void {
  // Vite closes successful watch outputs, which invokes electron-vite's reload hook.
  watcher.on('event', async (event) => {
    if (event.code === 'BUNDLE_END') {
      await event.result.close()
    }
  })
}

function readEmittedVersion(root: string): number {
  const result = runProcessSync({
    program: process.execPath,
    args: ['-e', `console.log(require(${JSON.stringify(join(root, 'out', 'main.cjs'))}).version)`],
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr || 'The emitted main entry did not load')
  }
  return Number(result.stdout.trim())
}

describe('External process-host development rebuilds', () => {
  it('emits private source edits and new imports before the Electron reload hook', async () => {
    const { root, packageDir, main } = fixture()
    const loadedVersions: number[] = []
    const reloadHook: Plugin = {
      name: 'fake-electron-reload',
      closeBundle() {
        loadedVersions.push(readEmittedVersion(root))
      }
    }
    const watcher = watch({
      input: main,
      external: ['@orca/process-host'],
      plugins: [createProcessHostDevRebuildPlugin(root), reloadHook],
      output: { file: join(root, 'out', 'main.cjs'), format: 'cjs' }
    })
    watchers.push(watcher)
    closeSuccessfulBundles(watcher)
    await nextEvent(watcher, 'END')
    expect(loadedVersions).toEqual([1])
    expect(readFileSync(join(root, 'out', 'main.cjs'), 'utf8')).toContain('@orca/process-host')

    writeFileSync(join(packageDir, 'src', 'internal.ts'), 'export const version = 2\n')
    await expect.poll(() => loadedVersions.at(-1), { timeout: 15_000 }).toBe(2)

    writeFileSync(join(packageDir, 'src', 'new-feature.ts'), 'export const added = 3\n')
    writeFileSync(
      join(packageDir, 'src', 'internal.ts'),
      "import { added } from './new-feature'\nexport const version = added\n"
    )
    await expect.poll(() => loadedVersions.at(-1), { timeout: 15_000 }).toBe(3)
    await expect
      .poll(() => existsSync(join(packageDir, 'dist', 'new-feature.js')), { timeout: 15_000 })
      .toBe(true)
    expect(readFileSync(join(packageDir, 'dist', 'new-feature.js'), 'utf8')).toContain('added = 3')
  })

  it('rebuilds when an inherited compiler configuration changes', async () => {
    const { root, packageDir, main } = fixture()
    const watcher = watch({
      input: main,
      external: ['@orca/process-host'],
      plugins: [createProcessHostDevRebuildPlugin(root)],
      output: { file: join(root, 'out', 'main.cjs'), format: 'cjs' }
    })
    watchers.push(watcher)
    closeSuccessfulBundles(watcher)
    await nextEvent(watcher, 'END')
    const emittedSource = join(packageDir, 'dist', 'internal.js')
    expect(readFileSync(emittedSource, 'utf8')).toContain('preserved comment')

    writeFileSync(
      join(root, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { strict: true, removeComments: true } })
    )
    await expect
      .poll(() => readFileSync(emittedSource, 'utf8'), { timeout: 15_000 })
      .not.toContain('preserved comment')
  })

  it('reports a failed compilation, preserves prior output, and recovers after a fix', async () => {
    const { root, packageDir, main } = fixture()
    const loadedVersions: number[] = []
    const watcher = watch({
      input: main,
      external: ['@orca/process-host'],
      plugins: [
        createProcessHostDevRebuildPlugin(root),
        {
          name: 'fake-electron-reload',
          closeBundle() {
            loadedVersions.push(readEmittedVersion(root))
          }
        }
      ],
      output: { file: join(root, 'out', 'main.cjs'), format: 'cjs' }
    })
    watchers.push(watcher)
    closeSuccessfulBundles(watcher)
    await nextEvent(watcher, 'END')

    const failed = nextEvent(watcher, 'ERROR')
    writeFileSync(join(packageDir, 'src', 'internal.ts'), "export const version: number = 'bad'\n")
    await failed
    expect(loadedVersions.at(-1)).toBe(1)
    expect(readEmittedVersion(root)).toBe(1)

    writeFileSync(join(packageDir, 'src', 'internal.ts'), 'export const version = 4\n')
    await expect.poll(() => loadedVersions.at(-1), { timeout: 15_000 }).toBe(4)
  })

  it('recovers when a missing import is created in a new source directory', async () => {
    const { root, packageDir, main } = fixture()
    const loadedVersions: number[] = []
    const watchSignals = new Set<string>()
    const watcher = watch({
      input: main,
      external: ['@orca/process-host'],
      plugins: [
        createProcessHostDevRebuildPlugin(root),
        {
          name: 'fake-electron-reload',
          closeBundle() {
            loadedVersions.push(readEmittedVersion(root))
          }
        }
      ],
      output: { file: join(root, 'out', 'main.cjs'), format: 'cjs' }
    })
    watcher.on('change', (file) => {
      if (basename(file) === 'source-directory-change') {
        watchSignals.add(file)
      }
    })
    watchers.push(watcher)
    closeSuccessfulBundles(watcher)
    await nextEvent(watcher, 'END')

    const failed = nextEvent(watcher, 'ERROR')
    writeFileSync(
      join(packageDir, 'src', 'internal.ts'),
      "export { version } from './features/new-feature'\n"
    )
    await failed
    expect(loadedVersions.at(-1)).toBe(1)
    expect(readEmittedVersion(root)).toBe(1)

    mkdirSync(join(packageDir, 'src', 'features'))
    writeFileSync(
      join(packageDir, 'src', 'features', 'new-feature.ts'),
      'export const version = 5\n'
    )
    await expect.poll(() => loadedVersions.at(-1), { timeout: 15_000 }).toBe(5)
    expect(existsSync(join(packageDir, 'dist', 'features', 'new-feature.js'))).toBe(true)
    expect(watchSignals.size).toBe(1)

    const failedAgain = nextEvent(watcher, 'ERROR')
    writeFileSync(
      join(packageDir, 'src', 'internal.ts'),
      "export { version } from './features/still-missing'\n"
    )
    await failedAgain
    expect(readEmittedVersion(root)).toBe(5)

    await watcher.close()
    watchers.splice(watchers.indexOf(watcher), 1)
    for (const signal of watchSignals) {
      expect(existsSync(dirname(signal))).toBe(false)
    }
  })

  it('leaves non-watch release compilation to the build:packages prerequisite', async () => {
    const bundle = await rolldown({
      input: resolve('src/packages/process-host/src/process-spec.ts'),
      plugins: [createProcessHostDevRebuildPlugin('/unavailable-development-root')]
    })
    try {
      await bundle.generate({ format: 'cjs' })
    } finally {
      await bundle.close()
    }
  })
})
