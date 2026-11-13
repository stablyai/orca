import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, Rollup } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlainNodeEntryGuardPlugin } from '../../../build-plugins/plain-node-entry-guard'

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

async function runCloseBundle(plugin: Plugin): Promise<void> {
  const hook = plugin.closeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected closeBundle hook')
  }
  await hook.call({} as never)
}

describe('plain Node entry guard', () => {
  it('smoke-loads the daemon after output files are written', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, dir)).not.toThrow()
    writeFileSync(
      join(dir, 'daemon-entry.js'),
      'console.error("Usage: daemon-entry <socket>"); process.exit(1)\n'
    )

    await expect(runCloseBundle(plugin)).resolves.toBeUndefined()
  })

  it('runs the deferred smoke from closeBundle', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    runWriteBundle(plugin, dir)
    writeFileSync(join(dir, 'daemon-entry.js'), "require('./missing-module')\n")

    await expect(runCloseBundle(plugin)).rejects.toThrow('failed to load under plain Node')
  })

  it('rejects Electron subpath requires', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, createOutputDir(), 'require("electron/main")')).toThrow(
      'requires electron'
    )
  })

  it('rejects a daemon-graph package the relocated Windows daemon-host does not mirror', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() =>
      runWriteBundle(plugin, createOutputDir(), 'const nacl = require(`tweetnacl`)')
    ).toThrow('does not mirror')
    expect(() =>
      runWriteBundle(
        plugin,
        createOutputDir(),
        'require("node:fs"); require("path"); require("@orca/process-host/spawn-observer"); require("node-pty")'
      )
    ).not.toThrow()
  })

  it('fails the smoke when the daemon exits zero on an empty argv', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    runWriteBundle(plugin, dir)
    writeFileSync(join(dir, 'daemon-entry.js'), 'console.error("Usage: daemon-entry <socket>")\n')

    await expect(runCloseBundle(plugin)).rejects.toThrow('did not reject an empty argv')
  })
})

// Electron is unavailable in main-process workers too (#11161); transitive imports can kill startup despite entry-local electron-free comments.
describe('CLI and worker thread entry guard', () => {
  function runEntryWriteBundle(
    plugin: Plugin,
    bundle: Rollup.OutputBundle,
    watchMode = false
  ): void {
    const hook = plugin.writeBundle
    if (typeof hook !== 'function') {
      throw new Error('Expected writeBundle hook')
    }
    hook.call(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook reads only meta.watchMode from its context.
      { meta: { watchMode } } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook reads only dir from the output options.
      { dir: outputDir ?? createOutputDir() } as Rollup.NormalizedOutputOptions,
      bundle
    )
  }

  function entryChunk(name: string, code: string, imports: string[] = []): Rollup.OutputChunk {
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

  // Exercise transitive shared-chunk imports into the electron client, where direct-import checks miss startup failures.
  it('follows shared chunks out of a worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle: Rollup.OutputBundle = {
      'foreign-sqlite-reader-entry.js': entryChunk(
        'foreign-sqlite-reader-entry',
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
    }

    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('chunks/shared.js')
  })
})
