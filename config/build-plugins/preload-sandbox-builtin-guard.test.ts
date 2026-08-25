import { describe, expect, it } from 'vitest'
import type { Rollup } from 'vite'
import {
  assertPreloadSandboxBundleSafe,
  assertPreloadSandboxChunkSafe,
  createPreloadSandboxBuiltinGuardPlugin,
  findPreloadSandboxViolations
} from './preload-sandbox-builtin-guard'

type OutputChunk = Rollup.OutputChunk

function chunk(fileName: string, code: string, imports: string[] = []): OutputChunk {
  return {
    type: 'chunk',
    fileName,
    code,
    imports,
    dynamicImports: []
  } as unknown as OutputChunk
}

function runGuard(
  plugin: ReturnType<typeof createPreloadSandboxBuiltinGuardPlugin>,
  bundle: Record<string, OutputChunk>
): void {
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') {
    throw new Error('guard plugin must expose a generateBundle hook')
  }
  hook.call({ meta: { watchMode: true } } as never, {} as never, bundle as never, false)
}

describe('preload sandbox guard detection', () => {
  it('detects static CommonJS and ESM Node builtin requests', () => {
    expect(
      findPreloadSandboxViolations(
        'require("node:util"); import("node:path");\nimport value from "node:buffer";\nimport "node:fs"'
      )
    ).toEqual([
      { kind: 'node-builtin', detail: 'node:buffer' },
      { kind: 'node-builtin', detail: 'node:fs' },
      { kind: 'node-builtin', detail: 'node:path' },
      { kind: 'node-builtin', detail: 'node:util' }
    ])
  })

  it('detects bundler-renamed require shims', () => {
    expect(findPreloadSandboxViolations('var x = __require("fs")')).toEqual([
      { kind: 'node-builtin', detail: 'fs' }
    ])
  })

  it('detects non-literal require and import requests', () => {
    const violations = findPreloadSandboxViolations(
      'const m = require(name);\nconst d = await import(specifier)'
    )
    expect(violations.map((violation) => violation.kind)).toEqual([
      'nonliteral-module-request',
      'nonliteral-module-request'
    ])
    expect(violations.map((violation) => violation.detail)).toEqual([
      'import(specifier)',
      'require(name);'
    ])
  })

  it('rejects a bare npm external that a sandboxed preload cannot load', () => {
    expect(findPreloadSandboxViolations('require("zod")')).toEqual([
      { kind: 'unsupported-external', detail: 'zod' }
    ])
  })

  it('rejects an emitted Rollup helper chunk', () => {
    expect(findPreloadSandboxViolations('require("./chunks/shared-abc123.js")')).toEqual([
      { kind: 'helper-chunk', detail: './chunks/shared-abc123.js' }
    ])
  })

  it('rejects a shared chunk reported by its bare emitted path', () => {
    expect(() =>
      assertPreloadSandboxChunkSafe(
        chunk('index.js', 'export {}', ['chunks/chunk-BTjIgr6M.js', 'ssh2'])
      )
    ).toThrow(
      'unloadable emitted chunks: chunks/chunk-BTjIgr6M.js; unsupported bare externals: ssh2'
    )
  })

  it('accepts the explicit Electron preload surface and browser-safe code', () => {
    expect(
      findPreloadSandboxViolations(
        'require("electron"); const bytes = new TextEncoder().encode("safe")'
      )
    ).toEqual([])
  })

  it('rejects Electron subpath exports the emitted preload never uses', () => {
    expect(findPreloadSandboxViolations('require("electron/renderer")')).toEqual([
      { kind: 'unsupported-external', detail: 'electron/renderer' }
    ])
  })

  it('does not flag identifiers or quoted data that merely look like module requests', () => {
    expect(
      findPreloadSandboxViolations(
        'const api = { importPetsFrom: () => ipc.invoke("a"), importPetBundle: () => ipc.invoke("b") };\n' +
          'const label = "import x from \'node:fs\'";\nconst got = cache.require("node:fs")'
      )
    ).toEqual([])
  })
})

// Why: the case above only covers identifier prefixes, a quoted *static import statement* off
// statement position, and member-access `require`. None of them exercise call syntax inside a
// literal, so the guard used to fail the build on comments and ordinary strings.
describe('preload sandbox guard lexical masking', () => {
  it('ignores a module call quoted inside a string literal', () => {
    expect(findPreloadSandboxViolations(`const help = "Call require('fs')"`)).toEqual([])
  })

  it('ignores a module call in a line comment, which survives an unminified chunk', () => {
    expect(findPreloadSandboxViolations("// use require('fs')\nexport {}")).toEqual([])
  })

  it('ignores a module call in a block comment', () => {
    expect(findPreloadSandboxViolations("/* see require('fs')\n   and import('path') */")).toEqual(
      []
    )
  })

  it('ignores a module call inside a template literal', () => {
    expect(findPreloadSandboxViolations('const t = `see import("path") here`')).toEqual([])
  })

  it('ignores a fake require after an escaped quote, which naive masking would end early', () => {
    expect(findPreloadSandboxViolations('const s = "a\\"require(\'fs\')\\"b"')).toEqual([])
  })

  it('still flags a real request inside a template interpolation', () => {
    expect(findPreloadSandboxViolations('const t = `${require("fs")}`')).toEqual([
      { kind: 'node-builtin', detail: 'fs' }
    ])
  })

  it('still flags a real request nested in an interpolated object literal', () => {
    expect(findPreloadSandboxViolations('const t = `${({ a: require("net") }).a}` + "x"')).toEqual([
      { kind: 'node-builtin', detail: 'net' }
    ])
  })

  it('still flags a real request on the line after a comment', () => {
    expect(findPreloadSandboxViolations('// hi\nconst x = require("node:os")')).toEqual([
      { kind: 'node-builtin', detail: 'node:os' }
    ])
  })

  // Why: same line on purpose — an unterminated string already stops at a newline, so only a
  // same-line regex can swallow the request that follows it.
  it('still flags a real request after a regex holding an unpaired quote', () => {
    expect(findPreloadSandboxViolations('const q = /["]/; const x = require("node:zlib")')).toEqual(
      [{ kind: 'node-builtin', detail: 'node:zlib' }]
    )
  })

  it('still flags a real request after a division, which is not a regex', () => {
    expect(findPreloadSandboxViolations('const r = t / 2; const x = require("node:dns")')).toEqual([
      { kind: 'node-builtin', detail: 'node:dns' }
    ])
  })

  it('still flags a real static import that follows a quoted decoy', () => {
    expect(findPreloadSandboxViolations('const d = "require(\'fs\')";\nimport "node:tty"')).toEqual(
      [{ kind: 'node-builtin', detail: 'node:tty' }]
    )
  })

  // `return /re/` is a regex, not division. The bare previous-character
  // heuristic sees the `n` of `return` and leaves the pattern unmasked, so a
  // safe preload fails to build.
  it('ignores a module call inside a regex that follows a keyword', () => {
    expect(findPreloadSandboxViolations('function f() { return /require("node:fs")/ }')).toEqual([])
  })

  it('still treats a slash after an identifier as division', () => {
    expect(
      findPreloadSandboxViolations('const r = total / count; const fs = require("node:fs")')
    ).toEqual([{ kind: 'node-builtin', detail: 'node:fs' }])
  })
})

describe('preload sandbox guard assertions', () => {
  it('names every offending specifier and the supported surface', () => {
    expect(() =>
      assertPreloadSandboxBundleSafe('index.js', 'require("node:util"); require("zod")')
    ).toThrow(
      /"index\.js" requests unsupported Node builtins: node:util; unsupported bare externals: zod\..*resolves only electron;/s
    )
  })

  it('rejects a resolved external that never appears in the emitted source', () => {
    expect(() =>
      assertPreloadSandboxChunkSafe(chunk('index.js', 'export {}', ['node:crypto']))
    ).toThrow('node:crypto')
  })

  it('accepts a chunk whose only resolved import is electron', () => {
    expect(() =>
      assertPreloadSandboxChunkSafe(chunk('index.js', 'var e = require("electron")', ['electron']))
    ).not.toThrow()
  })
})

describe('preload sandbox guard plugin', () => {
  it('fails in generateBundle, before Rollup writes the unsafe output', () => {
    const plugin = createPreloadSandboxBuiltinGuardPlugin()
    expect(plugin.writeBundle).toBeUndefined()
    expect(() =>
      runGuard(plugin, { 'index.js': chunk('index.js', 'require("node:path")') })
    ).toThrow('node:path')
  })

  it('guards only the included outputs when the build also emits Node entries', () => {
    const plugin = createPreloadSandboxBuiltinGuardPlugin({
      include: ['browser-window-close-preload.js']
    })
    expect(() =>
      runGuard(plugin, {
        'index.js': chunk('index.js', 'require("node:fs")', ['node:fs']),
        'browser-window-close-preload.js': chunk(
          'browser-window-close-preload.js',
          'var { contextBridge } = require("electron")',
          ['electron']
        )
      })
    ).not.toThrow()
  })

  it('guards the second sandboxed preload emitted by the main build', () => {
    const plugin = createPreloadSandboxBuiltinGuardPlugin({
      include: ['browser-window-close-preload.js']
    })
    expect(() =>
      runGuard(plugin, {
        'index.js': chunk('index.js', 'require("node:fs")'),
        'browser-window-close-preload.js': chunk(
          'browser-window-close-preload.js',
          'require("node:os")'
        )
      })
    ).toThrow('browser-window-close-preload.js')
  })

  it('fails when a guarded preload output is renamed out of the bundle', () => {
    const plugin = createPreloadSandboxBuiltinGuardPlugin({
      include: ['browser-window-close-preload.js']
    })
    expect(() =>
      runGuard(plugin, { 'index.js': chunk('index.js', 'require("electron")') })
    ).toThrow('guarded preload output missing from the bundle: browser-window-close-preload.js')
  })

  it('fails watch rebuilds too, so no dev out/ tree holds an unsafe preload', () => {
    const plugin = createPreloadSandboxBuiltinGuardPlugin()
    expect(() =>
      runGuard(plugin, { 'index.js': chunk('index.js', 'require("node:path")') })
    ).toThrow('node:path')
  })
})
