import type { NormalizedOutputOptions, OutputBundle, OutputChunk } from 'rollup'
import { describe, expect, it } from 'vitest'
import { createPlainNodeEntryGuardPlugin } from './plain-node-entry-guard'

function entryChunk(name: string, code: string, imports: string[] = []): OutputChunk {
  return {
    type: 'chunk',
    name,
    fileName: `${name}.js`,
    code,
    isEntry: true,
    imports,
    dynamicImports: []
  } as unknown as OutputChunk
}

describe('plain Node entry guard', () => {
  it('rejects electron imports reachable from the managed WSL watcher host', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const hook = plugin.writeBundle
    const chunk = entryChunk('wsl-watcher-host', 'require("electron")')
    const bundle = { [chunk.fileName]: chunk } as OutputBundle

    expect(() => {
      if (typeof hook === 'function') {
        hook.call(
          {
            meta: { watchMode: false, rollupVersion: 'test', viteVersion: 'test' }
          } as never,
          { dir: 'out/main' } as NormalizedOutputOptions,
          bundle
        )
      }
    }).toThrow(/wsl-watcher-host.*requires electron/)
  })

  it('rejects shared chunks that are not copied into the managed runtime', () => {
    const host = entryChunk('wsl-watcher-host', 'require("node:fs")', ['chunks/shared.js'])
    const shared = entryChunk('shared', 'module.exports = {}')
    shared.isEntry = false
    shared.fileName = 'chunks/shared.js'

    expect(() => runGuard([host, shared])).toThrow(/reaches shared chunk "chunks\/shared\.js"/)
  })

  it('rejects bare dependencies that are absent from the managed runtime', () => {
    const host = entryChunk('wsl-watcher-host', 'require("external-package")')

    expect(() => runGuard([host])).toThrow(/loads unavailable dependency "external-package"/)
  })

  it('allows only Node built-ins and the staged native watcher binding', () => {
    const host = entryChunk(
      'wsl-watcher-host',
      'require("node:fs"); require("path"); require("./watcher.node"); require.main === module'
    )

    expect(() => runGuard([host])).not.toThrow()
  })

  it('rejects a bare native watcher loader that Node would resolve as a package', () => {
    const host = entryChunk('wsl-watcher-host', 'require("watcher.node")')

    expect(() => runGuard([host])).toThrow(/loads unavailable dependency "watcher\.node"/)
  })

  it('rejects Rollup assets that are absent from the staged dependency set', () => {
    const host = entryChunk('wsl-watcher-host', 'require("node:fs")')
    host.referencedFiles = ['assets/runtime-data.bin']

    expect(() => runGuard([host])).toThrow(/references unstaged asset/)
  })

  it('rejects implicit chunks that would not be copied beside host.js', () => {
    const host = entryChunk('wsl-watcher-host', 'require("node:fs")')
    host.implicitlyLoadedBefore = ['chunks/implicit.js']
    const implicit = entryChunk('implicit', 'module.exports = {}')
    implicit.isEntry = false
    implicit.fileName = 'chunks/implicit.js'

    expect(() => runGuard([host, implicit])).toThrow(/reaches shared chunk "chunks\/implicit\.js"/)
  })

  it.each([
    'require.resolve("external-package")',
    'module.require("external-package")',
    'import(loaderTarget)',
    'createRequire(import.meta.url)'
  ])('rejects indirect or dynamic loaders: %s', (code) => {
    const host = entryChunk('wsl-watcher-host', code)

    expect(() => runGuard([host])).toThrow(
      /dependencies cannot be proven|loads unavailable dependency/
    )
  })

  it.each([
    'const load = require; load("external-package")',
    'const load = module.require; load("external-package")',
    'const load = require.resolve; load("external-package")',
    'const { require: load } = module; load("external-package")',
    'module["req" + "uire"]("external-package")',
    'const property = "require"; module[property]("external-package")',
    'require["res" + "olve"]("external-package")'
  ])('rejects aliased CommonJS loaders: %s', (code) => {
    const host = entryChunk('wsl-watcher-host', code)

    expect(() => runGuard([host])).toThrow(/dependencies cannot be proven/)
  })
})

function runGuard(chunks: OutputChunk[]): void {
  const hook = createPlainNodeEntryGuardPlugin().writeBundle
  const bundle = Object.fromEntries(chunks.map((chunk) => [chunk.fileName, chunk])) as OutputBundle
  if (typeof hook === 'function') {
    hook.call(
      {
        meta: { watchMode: false, rollupVersion: 'test', viteVersion: 'test' }
      } as never,
      { dir: 'out/main' } as NormalizedOutputOptions,
      bundle
    )
  }
}
