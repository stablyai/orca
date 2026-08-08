import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, Rollup } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlainNodeEntryGuardPlugin } from '../build-plugins/plain-node-entry-guard'

let outputDir: string | undefined

afterEach(() => {
  if (outputDir) {
    rmSync(outputDir, { recursive: true, force: true })
    outputDir = undefined
  }
})

function createOutputDir(): string {
  outputDir = mkdtempSync(join(tmpdir(), 'orca-plain-node-entry-guard-'))
  return outputDir
}

function createBundle(code = ''): Rollup.OutputBundle {
  return {
    'daemon-entry.js': {
      type: 'chunk',
      code,
      dynamicImports: [],
      fileName: 'daemon-entry.js',
      imports: [],
      isEntry: true,
      name: 'daemon-entry'
    } as Rollup.OutputChunk
  }
}

function runWriteBundle(plugin: Plugin, dir: string, code = ''): void {
  const hook = plugin.writeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected writeBundle hook')
  }
  hook.call(
    { meta: { watchMode: false } } as never,
    { dir } as Rollup.NormalizedOutputOptions,
    createBundle(code)
  )
}

function runCloseBundle(plugin: Plugin): void {
  const hook = plugin.closeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected closeBundle hook')
  }
  hook.call({} as never)
}

describe('plain Node entry guard', () => {
  it('smoke-loads the daemon after output files are written', () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, dir)).not.toThrow()
    writeFileSync(
      join(dir, 'daemon-entry.js'),
      'console.error("Usage: daemon-entry <socket>"); process.exit(1)\n'
    )

    expect(() => runCloseBundle(plugin)).not.toThrow()
  })

  it('runs the deferred smoke from closeBundle', () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    runWriteBundle(plugin, dir)
    writeFileSync(join(dir, 'daemon-entry.js'), "require('./missing-module')\n")

    expect(() => runCloseBundle(plugin)).toThrow('failed to load under plain Node')
  })

  it('rejects Electron imports during the static bundle scan', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, createOutputDir(), 'require("electron")')).toThrow(
      'requires electron'
    )
  })
})

// Why (#11161): Electron's module is not registered on worker threads either —
// require("electron") throws "Cannot find module 'electron'" inside a
// main-process worker and kills it at startup. The worker entries carried only
// hand-written "must stay electron-free" comments, and the port-scan worker sits
// one import away from a client that deliberately does require electron.
describe('worker thread entry guard', () => {
  function runWorkerWriteBundle(plugin: Plugin, bundle: Rollup.OutputBundle): void {
    const hook = plugin.writeBundle
    if (typeof hook !== 'function') {
      throw new Error('Expected writeBundle hook')
    }
    hook.call(
      { meta: { watchMode: false } } as never,
      { dir: createOutputDir() } as Rollup.NormalizedOutputOptions,
      bundle
    )
  }

  function workerChunk(name: string, code: string, imports: string[] = []): Rollup.OutputChunk {
    return {
      type: 'chunk',
      code,
      dynamicImports: [],
      fileName: `${name}.js`,
      imports,
      isEntry: true,
      name
    } as Rollup.OutputChunk
  }

  it('rejects an Electron require reachable from a worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle = {
      'port-scan-command-worker-entry.js': workerChunk(
        'port-scan-command-worker-entry',
        'require("electron")'
      )
    } as Rollup.OutputBundle

    expect(() => runWorkerWriteBundle(plugin, bundle)).toThrow('requires electron')
  })

  it('names the worker-thread runtime so the failure is actionable', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle = {
      'stt-worker.js': workerChunk('stt-worker', 'require("electron")')
    } as Rollup.OutputBundle

    expect(() => runWorkerWriteBundle(plugin, bundle)).toThrow('runs as a worker thread')
  })

  // The real risk is transitive: a worker entry importing a shared chunk that
  // reaches the electron-requiring client, not a direct import anyone would spot.
  it('follows shared chunks out of a worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle = {
      'session-scanner-opencode-sqlite-worker-entry.js': workerChunk(
        'session-scanner-opencode-sqlite-worker-entry',
        'require("./chunks/shared.js")',
        ['chunks/shared.js']
      ),
      'chunks/shared.js': {
        type: 'chunk',
        code: 'require("electron")',
        dynamicImports: [],
        fileName: 'chunks/shared.js',
        imports: [],
        isEntry: false,
        name: 'shared'
      } as Rollup.OutputChunk
    } as Rollup.OutputBundle

    expect(() => runWorkerWriteBundle(plugin, bundle)).toThrow('chunks/shared.js')
  })

  it('passes a clean worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle = {
      'warp-theme-parser-worker.js': workerChunk(
        'warp-theme-parser-worker',
        'require("node:worker_threads")'
      )
    } as Rollup.OutputBundle

    expect(() => runWorkerWriteBundle(plugin, bundle)).not.toThrow()
  })
})
