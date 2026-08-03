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
