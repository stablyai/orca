import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'
import { stagePackagedProcessHost } from './packaged-process-host-fixture.mjs'
import { runProcessSync } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const { collectRuntimeClosure } = require('./verify-skills-cli-runtime.cjs')
const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath

it('loads the copied process package from an unpacked CLI without checkout dependencies', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-process-host-'))
  try {
    const resource = createPackagedRuntimeNodeModuleResources().find(
      (entry) => entry.to === join('node_modules', '@orca', 'process-host')
    )
    expect(resource).toBeDefined()
    expect(resource.filter).toEqual(['package.json', 'dist/**/*'])
    const packageDir = await stagePackagedProcessHost(resourcesDir)
    expect(existsSync(join(packageDir, 'src'))).toBe(false)

    const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
    const cliDir = join(outDir, 'cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(join(outDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
    const entry = join(cliDir, 'index.js')
    await writeFile(
      entry,
      [
        "const assert = require('node:assert/strict')",
        "const { once } = require('node:events')",
        "const { runProcessSync, runProcess, spawnProcess } = require('@orca/process-host')",
        "const { setSpawnObserver } = require('@orca/process-host/spawn-observer')",
        "const { setProcessTreeKillGate } = require('@orca/process-host/process-tree-kill-gate')",
        "const { signalProcessTree } = require('@orca/process-host/process-tree-termination')",
        "import('@orca/process-host').then(async ({ runProcessSync: esmRunProcessSync }) => {",
        'assert.equal(runProcessSync, esmRunProcessSync)',
        'const result = runProcessSync({',
        '  program: process.execPath,',
        "  args: ['-e', 'process.stdout.write(\"copied-runtime\")']",
        '})',
        'assert.equal(result.code, 0)',
        'const observedCommands = []',
        'const gateCalls = []',
        'setSpawnObserver((command) => observedCommands.push(command))',
        'let child, closed, watchdog',
        'try {',
        'const observed = await runProcess({',
        '  program: process.execPath,',
        "  args: ['-e', 'process.stdout.write(\"observed-spawn\")']",
        '})',
        'assert.equal(observed.code, 0)',
        'assert.equal(observed.stdout, "observed-spawn")',
        'assert.deepEqual(observedCommands, [process.execPath])',
        'child = spawnProcess({',
        '  program: process.execPath,',
        "  args: ['-e', 'setInterval(() => {}, 1000)'],",
        '  detached: true',
        '})',
        'closed = once(child, "close")',
        'watchdog = setTimeout(() => child.kill("SIGKILL"), 5000)',
        'const rootSignals = []',
        'const killRoot = child.kill.bind(child)',
        'child.kill = (signal) => { rootSignals.push(signal); return killRoot(signal) }',
        'setProcessTreeKillGate((request) => { gateCalls.push(request); return false })',
        'const verified = await signalProcessTree(child, "SIGTERM")',
        'await closed',
        'assert.equal(verified, false)',
        'assert.equal(gateCalls.length, 1)',
        'assert.equal(gateCalls[0].pid, child.pid)',
        'assert.equal(gateCalls[0].scope, process.platform === "win32" ? "win-taskkill-tree" : "posix-process-group")',
        'assert.deepEqual(rootSignals, ["SIGTERM"])',
        'assert.deepEqual(observedCommands, [process.execPath, process.execPath])',
        '} finally {',
        'clearTimeout(watchdog)',
        'setSpawnObserver(null)',
        'setProcessTreeKillGate(null)',
        'if (child && child.exitCode === null && child.signalCode === null) {',
        '  child.kill("SIGKILL")',
        '  await closed',
        '}',
        '}',
        'process.stdout.write(result.stdout)',
        '}).catch((error) => { console.error(error); process.exitCode = 1 })'
      ].join('\n'),
      'utf8'
    )
    const closure = collectRuntimeClosure(outDir, resourcesDir)
    expect(closure).toContain(realpathSync(join(packageDir, 'dist', 'run-process.js')))
    const result = runProcessSync({
      program: nodeExecutable,
      args: [entry],
      cwd: resourcesDir,
      timeoutMs: 15_000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('copied-runtime')
  } finally {
    await removeTree(resourcesDir)
  }
})

describe('process-host output packaging guard', () => {
  const { assertProcessHostOutputBuilt } = require('../packaged-runtime-node-modules.cjs')
  const electronBuilderConfig = require('../electron-builder.config.cjs')

  async function builtPackage() {
    const packageDir = await mkdtemp(join(tmpdir(), 'orca-process-host-output-'))
    await mkdir(join(packageDir, 'src', '__fixtures__'), { recursive: true })
    await mkdir(join(packageDir, 'dist'))
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        main: './dist/entry.js',
        exports: {
          '.': { types: './dist/entry.d.ts', default: './dist/entry.js' },
          './feature': { default: './dist/feature.js' }
        }
      })
    )
    for (const module of ['entry', 'feature', 'internal']) {
      await writeFile(join(packageDir, 'src', `${module}.ts`), '')
      await writeFile(join(packageDir, 'dist', `${module}.js`), '')
    }
    await writeFile(join(packageDir, 'src', 'entry.test.ts'), '')
    await writeFile(join(packageDir, 'src', '__fixtures__', 'child.ts'), '')
    return packageDir
  }

  it('accepts complete output and ignores test and fixture sources', async () => {
    const packageDir = await builtPackage()
    try {
      expect(() => assertProcessHostOutputBuilt(packageDir)).not.toThrow()
    } finally {
      await removeTree(packageDir)
    }
  })

  it('accepts the checkout package', () => {
    expect(() => assertProcessHostOutputBuilt()).not.toThrow()
  })

  it.each([
    ['a public export target', 'feature.js', /missing: \.\/dist\/feature\.js/],
    ['an internal module', 'internal.js', /missing: \.\/dist\/internal\.js/]
  ])('fails when %s was never emitted', async (_label, file, message) => {
    const packageDir = await builtPackage()
    try {
      await rm(join(packageDir, 'dist', file))
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(message)
    } finally {
      await removeTree(packageDir)
    }
  })

  it('fails when dist is absent', async () => {
    const packageDir = await builtPackage()
    try {
      await rm(join(packageDir, 'dist'), { recursive: true })
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(/pnpm build:packages/)
    } finally {
      await removeTree(packageDir)
    }
  })

  it('fails when dist still holds output of a removed source', async () => {
    const packageDir = await builtPackage()
    try {
      await writeFile(join(packageDir, 'dist', 'renamed-away.js'), '')
      expect(() => assertProcessHostOutputBuilt(packageDir)).toThrow(
        /stale: \.\/dist\/renamed-away\.js/
      )
    } finally {
      await removeTree(packageDir)
    }
  })

  it('runs in beforePack', () => {
    expect(String(electronBuilderConfig.beforePack)).toContain('assertProcessHostOutputBuilt()')
  })
})
