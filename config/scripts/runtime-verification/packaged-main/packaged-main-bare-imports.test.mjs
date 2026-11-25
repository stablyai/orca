import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { missingBareImports } = createRequire(import.meta.url)('./packaged-main-bare-imports.cjs')
const everyPackageMissing = (specifier) =>
  !specifier.startsWith('.') && !specifier.startsWith('node:')

describe('missingBareImports', () => {
  it('ignores require() text that code generators keep in strings', () => {
    // ajv's own bundled shape: codegen text for its standalone output, never run as a require.
    const source =
      'var t=mz();t.code=`require("ajv/dist/runtime/uri").default`;' +
      'a.formats??(a.formats=(0,i._)`require("ajv-formats/dist/formats").${r}`);' +
      'const s="require(\'serve-sim\')";const n=require("node:path")'
    expect(missingBareImports(source, 'chunk.js', everyPackageMissing)).toEqual([])
  })

  it('reports every real load of a missing package, including one inside a template', () => {
    const source =
      'const a=require("ajv");const b=`${require("ajv-formats")}`;' +
      'import("smol-toml").then(()=>{});const c=require(`yaml`);const d=x.require("tldts")'
    expect(missingBareImports(source, 'chunk.js', everyPackageMissing).sort()).toEqual([
      'ajv',
      'ajv-formats',
      'smol-toml',
      'yaml'
    ])
  })
})
