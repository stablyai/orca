import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { readBundledWebClientFiles } from '../../src/shared/bundled-web-client-manifest'

it('preserves the Haskell license and provenance through a real Vite build and web projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-haskell-notices-'))
  const viteRoot = dirname(createRequire(import.meta.url).resolve('vite/package.json'))
  const plugin = resolve('config/build-plugins/haskell-grammar-notices.ts')
  const project = resolve('config/scripts/project-renderer-web-client.mjs')
  try {
    for (const html of ['index.html', 'web-index.html']) {
      writeFileSync(
        join(root, html),
        `<html><head></head><body><script type="module" src="./${html === 'index.html' ? 'desktop' : 'entry'}.js"></script></body></html>`
      )
    }
    writeFileSync(join(root, 'desktop.js'), 'document.body.textContent = "desktop fixture"')
    writeFileSync(join(root, 'entry.js'), 'document.body.textContent = "fixture"')
    writeFileSync(
      join(root, 'vite.config.mjs'),
      `import { createHaskellGrammarNoticesPlugin } from ${JSON.stringify(plugin)};
export default { base:'./', plugins:[createHaskellGrammarNoticesPlugin()], build:{outDir:'out/renderer',manifest:true,rollupOptions:{input:['index.html','web-index.html']}} }`
    )
    const built = await runProcess({
      program: process.execPath,
      args: [join(viteRoot, 'bin/vite.js'), 'build'],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 30000
    })
    expect(built.code, built.stderr).toBe(0)
    const projected = await runProcess({
      program: process.execPath,
      args: [project],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 30000
    })
    expect(projected.code, projected.stderr).toBe(0)
    const manifest = readBundledWebClientFiles(join(root, 'out/renderer'))
    for (const name of ['LICENSE', 'UPSTREAM']) {
      const asset = `assets/language-haskell-${name}.txt`
      const original = readFileSync(resolve(`resources/licenses/language-haskell/${name}.txt`))
      expect(manifest?.has(asset)).toBe(true)
      for (const output of ['renderer', 'web']) {
        expect(readFileSync(join(root, 'out', output, asset))).toEqual(original)
        expect(readFileSync(join(root, 'out', output, 'web-index.html'), 'utf8')).toContain(
          `href="./${asset}"`
        )
      }
      expect(readFileSync(join(root, 'out/renderer/index.html'), 'utf8')).toContain(
        `href="./${asset}"`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
