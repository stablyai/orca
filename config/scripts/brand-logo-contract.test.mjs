import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '..', '..')
const read = (...parts) => readFileSync(join(projectDir, ...parts), 'utf8')
const paths = (svg) => [...svg.matchAll(/<path\s+d="([^"]+)"/g)].map((match) => match[1])

describe('Parallel Merge brand assets', () => {
  const canonicalPaths = paths(read('resources', 'logo.svg'))

  it('keeps every SVG master on the canonical geometry', () => {
    expect(canonicalPaths).toHaveLength(4)
    for (const asset of [
      ['resources', 'icon-source', 'icon.icon', 'Assets', 'logo.svg']
    ]) {
      expect(paths(read(...asset))).toEqual(canonicalPaths)
    }
  })

  it('renders every raster variant from the canonical SVG body', () => {
    const renderer = read('config', 'scripts', 'render-brand-assets.mjs')
    expect(renderer).toContain("readFileSync(resourcePath('logo.svg'), 'utf8')")
    expect(renderer).not.toMatch(/<path\s+d=/)
  })

  it('brands the dev Windows Electron executable with the dev icon', () => {
    const runner = read('config', 'scripts', 'run-electron-vite-dev.mjs')
    expect(runner).toContain("path.join(repoRoot, 'resources', 'build', 'icon-dev.ico')")
    expect(runner).toContain("requireFromBuilder('app-builder-lib/out/util/resEdit')")
  })
})
