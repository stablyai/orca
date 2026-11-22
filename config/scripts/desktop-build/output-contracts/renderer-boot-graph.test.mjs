import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyRendererBootGraph } from './renderer-boot-graph.mjs'

it('fails renderer verification when a preloaded chunk bundles Node lru-cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-renderer-boot-graph-'))
  try {
    const i18nDir = join(root, 'src', 'renderer', 'src', 'i18n')
    mkdirSync(join(i18nDir, 'locales'), { recursive: true })
    writeFileSync(
      join(i18nDir, 'locales', 'en.json'),
      '{"route":"This fixture message is only needed on a deferred route."}'
    )
    writeFileSync(join(i18nDir, 'en-runtime-required.json'), '{}')

    const rendererDir = join(root, 'out', 'renderer')
    const assetsDir = join(rendererDir, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(
      join(rendererDir, 'index.html'),
      '<script type="module" src="./assets/entry.js"></script>\n' +
        '<link rel="modulepreload" href="./assets/dependency.js">'
    )
    writeFileSync(join(assetsDir, 'entry.js'), 'import "./dependency.js";')
    const dependency = join(assetsDir, 'dependency.js')
    writeFileSync(dependency, 'export const LigaturesAddon = class {};')
    expect(verifyRendererBootGraph(root)).toBe(0)

    writeFileSync(dependency, 'const metrics = diagnostics.channel("lru-cache:metrics");')
    expect(verifyRendererBootGraph(root)).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
