import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.resolve('@tailwindcss/vite'))
const { compile } = require('@tailwindcss/node')
const { Scanner } = require('@tailwindcss/oxide')

it('generates renderer CSS from production files while excluding test and spec files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-tailwind-sources-'))
  try {
    const renderer = join(root, 'src', 'renderer', 'src')
    const assets = join(renderer, 'assets')
    cpSync(resolve('src/renderer/src/assets'), assets, { recursive: true })
    cpSync(resolve('src/shared/styles'), join(root, 'src', 'shared', 'styles'), { recursive: true })
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction')
    const components = join(renderer, 'components')
    mkdirSync(components)
    writeFileSync(join(components, 'example.tsx'), 'export const style = "z-[31415]"')
    writeFileSync(join(components, 'example.test.tsx'), 'export const style = "z-[27182]"')
    writeFileSync(join(components, 'example.spec.ts'), 'export const style = "z-[16180]"')

    const compiler = await compile(readFileSync(join(assets, 'main.css'), 'utf8'), {
      base: assets,
      onDependency() {}
    })
    const automaticSources =
      compiler.root === 'none' ? [] : [compiler.root ?? { base: root, pattern: '**/*' }]
    const scanner = new Scanner({
      sources: [
        ...automaticSources.map((source) => ({ ...source, negated: false })),
        ...compiler.sources
      ]
    })
    const css = compiler.build(scanner.scan())
    expect(css).toContain('z-index: 31415')
    expect(css).not.toContain('z-index: 27182')
    expect(css).not.toContain('z-index: 16180')

    writeFileSync(join(components, 'added.tsx'), 'export const style = "z-[14142]"')
    expect(compiler.build(scanner.scan())).toContain('z-index: 14142')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
